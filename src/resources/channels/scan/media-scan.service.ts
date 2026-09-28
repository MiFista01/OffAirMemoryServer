import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Channel, ChannelCartoon, ChannelEpisode } from '@entities';
import { IsNull, Repository } from 'typeorm';
import { Dirent, existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { extname, join, posix } from 'path';
import { BusinessValidationService } from '@utils';
import { getVideoDurationSec, mapLimit } from './video-duration';
import { DURATION_CONCURRENCY, EPISODE_BATCH_SIZE, EPISODE_FILE, SEASON_DIR, SKIP_DIRS, SPECIALS_DIR, VIDEO_EXT } from '@constants';
import { MediaScanStatus, ScanContext, ScanIndex, ScanCounters } from '@app-types';
import { ScheduleDayService } from 'src/resources/schedule-day/schedule-day/schedule-day.service';

@Injectable()
export class MediaScanService implements OnModuleInit {
  private readonly logger = new Logger(MediaScanService.name);
  private readonly processStartedAt = new Date();
  private scanning = false;
  private lastScan: MediaScanStatus['lastScan'] = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Channel)
    private readonly channelRep: Repository<Channel>,
    @InjectRepository(ChannelCartoon)
    private readonly cartoonRep: Repository<ChannelCartoon>,
    @InjectRepository(ChannelEpisode)
    private readonly episodeRep: Repository<ChannelEpisode>,
    private readonly businessValidation: BusinessValidationService,
    @Inject(forwardRef(() => ScheduleDayService))
    private readonly scheduleDays: ScheduleDayService,
  ) {}

  get scanOnBoot(): boolean {
    return this.config.get<string>('SCAN_ON_BOOT') === 'true';
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  async onModuleInit() {
    if (this.scanOnBoot) {
      void this.scan().catch(() => console.log('Error scanning media on boot'));
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scanAtMidnight() {
    if (this.scanning) return;
    await this.scan();
  }

  async getStatus(): Promise<MediaScanStatus> {
    const channels = await this.channelRep.count();
    const cartoons = await this.cartoonRep.count();
    const episodes = await this.episodeRep.count();
    return {
      processStartedAt: this.processStartedAt.toISOString(),
      uptimeSec: Math.floor(
        (Date.now() - this.processStartedAt.getTime()) / 1000,
      ),
      lifecycle: process.env.npm_lifecycle_event ?? null,
      scanOnBoot: this.scanOnBoot,
      isScanning: this.scanning,
      lastScan: this.lastScan,
      counts: { channels, cartoons, episodes },
    };
  }

  async scan(): Promise<MediaScanStatus> {
    this.businessValidation.assert(
      !this.scanning,
      'Media scan is already running',
    );

    this.scanning = true;
    const started = Date.now();
    const created = this.emptyCounters();
    const existing = this.emptyCounters();

    try {
      const root = this.config.getOrThrow<string>('MEDIA_ROOT');
      this.businessValidation.assert(
        existsSync(root),
        `MEDIA_ROOT is not available: ${root}. Check that the drive is mounted.`,
      );
      const ctx: ScanContext = {
        root,
        index: await this.loadIndex(),
        created,
        existing,
      };
      await this.scanRoot(ctx);
      const durations = await this.fillMissingDurations(ctx.root);
      this.lastScan = this.buildLastScan(
        started,
        created,
        existing,
        durations,
        null,
      );
      // Boot schedule runs before scan; rebuild today after catalog is filled.
      try {
        await this.scheduleDays.createDaySchedule();
      } catch (e) {
        this.logger.warn(`post-scan schedule rebuild failed: ${e}`);
      }
      return this.getStatus();
    } catch (error) {
      this.lastScan = this.buildLastScan(
        started,
        created,
        existing,
        { filled: 0, failed: 0 },
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      this.scanning = false;
    }
  }

  private async loadIndex(): Promise<ScanIndex> {
    const [channels, cartoons, episodes] = await Promise.all([
      this.channelRep.find(),
      this.cartoonRep.find(),
      this.episodeRep.find({
        select: ['id', 'cartoonId', 'relativePath'],
      }),
    ]);
    return {
      channelBySlug: new Map(channels.map((c) => [c.slug, c])),
      cartoonByKey: new Map(
        cartoons.map((c) => [`${c.channelId}:${c.slug}`, c]),
      ),
      episodeByPath: new Set(
        episodes.map((e) => `${e.cartoonId}:${e.relativePath}`),
      ),
    };
  }

  private async scanRoot(ctx: ScanContext) {
    const channelDirs = await this.readDirs(ctx.root);
    for (const channelDir of channelDirs) {
      const channel = await this.upsertChannel(ctx, channelDir.name);
      await this.scanChannel(ctx, channel);
    }
  }

  private async upsertChannel(
    ctx: ScanContext,
    slug: string,
  ): Promise<Channel> {
    const existing = ctx.index.channelBySlug.get(slug);
    if (existing) {
      ctx.existing.channels += 1;
      return existing;
    }
    const channel = await this.channelRep.save(
      this.channelRep.create({
        slug,
        name: this.titleFromSlug(slug),
        isActive: false,
      }),
    );
    ctx.index.channelBySlug.set(slug, channel);
    ctx.created.channels += 1;
    return channel;
  }

  private async scanChannel(ctx: ScanContext, channel: Channel) {
    const showDirs = await this.readDirs(join(ctx.root, channel.slug));
    for (const showDir of showDirs) {
      const cartoon = await this.upsertCartoon(ctx, channel, showDir.name);
      await this.scanCartoon(ctx, channel, cartoon);
    }
  }

  private async upsertCartoon(
    ctx: ScanContext,
    channel: Channel,
    slug: string,
  ): Promise<ChannelCartoon> {
    const key = `${channel.id}:${slug}`;
    const existing = ctx.index.cartoonByKey.get(key);
    if (existing) {
      ctx.existing.cartoons += 1;
      return existing;
    }
    const cartoon = await this.cartoonRep.save(
      this.cartoonRep.create({
        channelId: channel.id,
        slug,
        name: this.titleFromSlug(slug),
        isActive: false,
        weight: 1,
        franchiseKey: null,
        eraOrder: null,
        cursorSeason: 0,
        cursorEpisode: 0,
      }),
    );
    ctx.index.cartoonByKey.set(key, cartoon);
    ctx.created.cartoons += 1;
    return cartoon;
  }

  private async scanCartoon(
    ctx: ScanContext,
    channel: Channel,
    cartoon: ChannelCartoon,
  ) {
    const childDirs = await this.readDirs(
      join(ctx.root, channel.slug, cartoon.slug),
    );
    const batch: ChannelEpisode[] = [];

    for (const child of childDirs) {
      const seasonMatch = child.name.match(SEASON_DIR);
      if (seasonMatch) {
        await this.collectSeasonEpisodes(
          ctx,
          channel,
          cartoon,
          Number(seasonMatch[1]),
          child.name,
          batch,
        );
        continue;
      }
      if (child.name.toLowerCase() === SPECIALS_DIR) {
        await this.collectSpecials(ctx, channel, cartoon, batch);
      }
    }

    if (batch.length) {
      await this.episodeRep.save(batch);
    }
  }

  private async collectSeasonEpisodes(
    ctx: ScanContext,
    channel: Channel,
    cartoon: ChannelCartoon,
    seasonNumber: number,
    seasonDirName: string,
    batch: ChannelEpisode[],
  ) {
    const files = await readdir(
      join(ctx.root, channel.slug, cartoon.slug, seasonDirName),
      { withFileTypes: true },
    );
    for (const file of files) {
      if (!file.isFile()) continue;
      const epMatch = file.name.match(EPISODE_FILE);
      if (!epMatch) continue;

      const episodeNumber = Number(epMatch[1]);
      const relativePath = posix.join(
        channel.slug,
        cartoon.slug,
        seasonDirName,
        file.name,
      );
      const pathKey = `${cartoon.id}:${relativePath}`;
      if (ctx.index.episodeByPath.has(pathKey)) {
        ctx.existing.episodes += 1;
        continue;
      }

      ctx.index.episodeByPath.add(pathKey);
      ctx.created.episodes += 1;
      batch.push(
        this.episodeRep.create({
          cartoonId: cartoon.id,
          kind: 'episode',
          seasonNumber,
          episodeNumber,
          slug: null,
          title: null,
          relativePath,
          durationSec: null,
          insertAfterEpisodeId: null,
          isActive: true,
        }),
      );
      if (batch.length >= EPISODE_BATCH_SIZE) {
        await this.episodeRep.save(batch.splice(0));
      }
    }
  }

  private async collectSpecials(
    ctx: ScanContext,
    channel: Channel,
    cartoon: ChannelCartoon,
    batch: ChannelEpisode[],
  ) {
    const files = await readdir(
      join(ctx.root, channel.slug, cartoon.slug, SPECIALS_DIR),
      { withFileTypes: true },
    );
    for (const file of files) {
      if (!file.isFile()) continue;
      const ext = extname(file.name).toLowerCase();
      if (!VIDEO_EXT.has(ext)) continue;

      const stem = file.name.slice(0, -ext.length);
      const slug = this.slugFromFileStem(stem);
      const relativePath = posix.join(
        channel.slug,
        cartoon.slug,
        SPECIALS_DIR,
        file.name,
      );
      const pathKey = `${cartoon.id}:${relativePath}`;
      if (ctx.index.episodeByPath.has(pathKey)) {
        ctx.existing.episodes += 1;
        continue;
      }

      ctx.index.episodeByPath.add(pathKey);
      ctx.created.episodes += 1;
      batch.push(
        this.episodeRep.create({
          cartoonId: cartoon.id,
          kind: 'special',
          seasonNumber: 0,
          episodeNumber: 0,
          slug,
          title: this.titleFromFileStem(stem),
          relativePath,
          durationSec: null,
          insertAfterEpisodeId: null,
          isActive: true,
        }),
      );
      if (batch.length >= EPISODE_BATCH_SIZE) {
        await this.episodeRep.save(batch.splice(0));
      }
    }
  }

  private async fillMissingDurations(root: string) {
    const missing = await this.episodeRep.find({
      where: { durationSec: IsNull() },
      select: ['id', 'relativePath'],
    });
    if (!missing.length) return { filled: 0, failed: 0 };

    const outcomes = await mapLimit(
      missing,
      DURATION_CONCURRENCY,
      async (episode) => {
        const filePath = join(root, ...episode.relativePath.split('/'));
        const durationSec = await getVideoDurationSec(filePath);
        if (durationSec == null) return false;
        await this.episodeRep.update(episode.id, { durationSec });
        return true;
      },
    );
    const filled = outcomes.filter(Boolean).length;
    return { filled, failed: outcomes.length - filled };
  }

  private emptyCounters(): ScanCounters {
    return { channels: 0, cartoons: 0, episodes: 0 };
  }

  private buildLastScan(
    started: number,
    created: ScanCounters,
    existing: ScanCounters,
    durations: { filled: number; failed: number },
    error: string | null,
  ): NonNullable<MediaScanStatus['lastScan']> {
    return {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      created,
      existing,
      durations,
      error,
    };
  }

  private titleFromSlug(slug: string): string {
    return slug
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private slugFromFileStem(stem: string): string {
    return stem
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 200);
  }

  private titleFromFileStem(stem: string): string {
    return stem
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async readDirs(dir: string): Promise<Dirent[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(
      (entry) =>
        entry.isDirectory() && !SKIP_DIRS.has(entry.name.toLowerCase()),
    );
  }
}
