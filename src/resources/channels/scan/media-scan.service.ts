import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Channel, ChannelCartoon, ChannelEpisode, ScheduleItem } from '@entities';
import { In, IsNull, Repository } from 'typeorm';
import { Dirent, existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { extname, join, posix } from 'path';
import { BusinessValidationService } from '@utils';
import { getVideoDurationSec, mapLimit } from './video-duration';
import { DURATION_CONCURRENCY, EPISODE_BATCH_SIZE, EPISODE_FILE, SEASON_DIR, SKIP_DIRS, SPECIALS_DIR, VIDEO_EXT } from '@constants';
import { MediaScanStatus, ScanContext, ScanIndex, ScanCounters } from '@app-types';
import { ScheduleDayService } from 'src/resources/schedule-day/schedule-day/schedule-day.service';
import { calendarDateInTz } from 'src/resources/stream/stream-air.util';

export type DurationReprobeResult = {
  at: string;
  durationMs: number;
  probed: number;
  updated: number;
  unchanged: number;
  failed: number;
  scheduleItemsUpdated: number;
  /** First mismatches (old → new), for quick eyeballing. */
  samples: Array<{
    episodeId: number;
    cartoonId: number;
    relativePath: string;
    oldSec: number | null;
    newSec: number;
  }>;
};
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
    @InjectRepository(ScheduleItem)
    private readonly scheduleItemRep: Repository<ScheduleItem>,
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
    const episodes = await this.episodeRep.count({ where: { isActive: true } });
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
    const removed = this.emptyCounters();
    const reactivated = this.emptyCounters();

    try {
      const root = this.config.getOrThrow<string>('MEDIA_ROOT').trim();
      this.businessValidation.assert(
        existsSync(root),
        `MEDIA_ROOT is not available: ${root}. Check that the drive is mounted.`,
      );
      const ctx: ScanContext = {
        root,
        index: await this.loadIndex(),
        created,
        existing,
        removed,
        reactivated,
        seenEpisodePaths: new Set(),
      };
      await this.scanRoot(ctx);
      await this.pruneMissingEpisodes(ctx);
      const durations = await this.fillMissingDurations(ctx.root);
      this.lastScan = this.buildLastScan(
        started,
        created,
        existing,
        removed,
        reactivated,
        durations,
        null,
      );
      this.logger.log(
        `scan done: +${created.episodes} ep, ~${existing.episodes} keep, ` +
          `↺${reactivated.episodes} on, -${removed.episodes} missing`,
      );
      // Create missing schedule days after catalog fill (does NOT wipe live day).
      // Existing today stays — inactive eps remain until next local midnight rebuild.
      try {
        await this.scheduleDays.createDaySchedule();
      } catch (e) {
        this.logger.warn(`post-scan schedule ensure failed: ${e}`);
      }
      return this.getStatus();
    } catch (error) {
      this.lastScan = this.buildLastScan(
        started,
        created,
        existing,
        removed,
        reactivated,
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
        select: ['id', 'cartoonId', 'relativePath', 'isActive'],
      }),
    ]);
    return {
      channelBySlug: new Map(channels.map((c) => [c.slug, c])),
      cartoonByKey: new Map(
        cartoons.map((c) => [`${c.channelId}:${c.slug}`, c]),
      ),
      episodeByPath: new Map(
        episodes.map((e) => [
          `${e.cartoonId}:${e.relativePath}`,
          {
            id: e.id,
            cartoonId: e.cartoonId,
            relativePath: e.relativePath,
            isActive: e.isActive,
          },
        ]),
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
      const saved = await this.episodeRep.save(batch);
      for (const ep of saved) {
        ctx.index.episodeByPath.set(`${ep.cartoonId}:${ep.relativePath}`, {
          id: ep.id,
          cartoonId: ep.cartoonId,
          relativePath: ep.relativePath,
          isActive: ep.isActive,
        });
      }
    }
  }

  private async touchExistingEpisode(
    ctx: ScanContext,
    pathKey: string,
  ): Promise<void> {
    ctx.seenEpisodePaths.add(pathKey);
    const ref = ctx.index.episodeByPath.get(pathKey);
    if (!ref) return;
    if (!ref.isActive) {
      await this.episodeRep.update(ref.id, { isActive: true });
      ref.isActive = true;
      ctx.reactivated.episodes += 1;
      this.logger.log(`reactivated episode id=${ref.id} ${ref.relativePath}`);
    } else {
      ctx.existing.episodes += 1;
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
        await this.touchExistingEpisode(ctx, pathKey);
        continue;
      }

      ctx.seenEpisodePaths.add(pathKey);
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
        const saved = await this.episodeRep.save(batch.splice(0));
        for (const ep of saved) {
          ctx.index.episodeByPath.set(`${ep.cartoonId}:${ep.relativePath}`, {
            id: ep.id,
            cartoonId: ep.cartoonId,
            relativePath: ep.relativePath,
            isActive: ep.isActive,
          });
        }
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
        await this.touchExistingEpisode(ctx, pathKey);
        continue;
      }

      ctx.seenEpisodePaths.add(pathKey);
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
        const saved = await this.episodeRep.save(batch.splice(0));
        for (const ep of saved) {
          ctx.index.episodeByPath.set(`${ep.cartoonId}:${ep.relativePath}`, {
            id: ep.id,
            cartoonId: ep.cartoonId,
            relativePath: ep.relativePath,
            isActive: ep.isActive,
          });
        }
      }
    }
  }

  /**
   * DB rows whose files are gone → deactivate (+ drop from today's schedule refs).
   * Hard-delete would break FKs; inactive episodes are ignored by the schedule builder.
   */
  private async pruneMissingEpisodes(ctx: ScanContext): Promise<void> {
    const missingIds: number[] = [];
    for (const [pathKey, ref] of ctx.index.episodeByPath) {
      if (ctx.seenEpisodePaths.has(pathKey)) continue;
      const filePath = join(ctx.root, ...ref.relativePath.split('/'));
      // NAS blip: retry once before deactivating (false missing → black holes in grid).
      let onDisk = existsSync(filePath);
      if (!onDisk) {
        await new Promise((r) => setTimeout(r, 120));
        onDisk = existsSync(filePath);
      }
      if (onDisk) {
        // File exists but wasn't under a scanned season folder name — keep.
        if (!ref.isActive) {
          await this.episodeRep.update(ref.id, { isActive: true });
          ref.isActive = true;
          ctx.reactivated.episodes += 1;
        }
        continue;
      }
      if (!ref.isActive) continue;
      missingIds.push(ref.id);
      ref.isActive = false;
    }
    if (!missingIds.length) return;

    await this.episodeRep.update(
      { id: In(missingIds) },
      { isActive: false },
    );
    // Do not delete live schedule rows mid-day — rebuild drops inactive eps.
    ctx.removed.episodes += missingIds.length;
    this.logger.warn(
      `deactivated ${missingIds.length} episode(s) missing on disk`,
    );
  }

  /**
   * Re-probe active episode files and rewrite durationSec when they differ.
   * Optionally sync today's schedule_item snapshots (fixes guide lingering on a
   * finished last slot when the grid duration was longer than the real file).
   */
  async reprobeDurations(opts?: {
    cartoonSlug?: string;
    syncSchedule?: boolean;
  }): Promise<DurationReprobeResult> {
    this.businessValidation.assert(
      !this.scanning,
      'Media scan is already running',
    );
    this.scanning = true;
    const started = Date.now();
    const syncSchedule = opts?.syncSchedule !== false;
    const samples: DurationReprobeResult['samples'] = [];
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    let scheduleItemsUpdated = 0;

    try {
      const root = this.config.getOrThrow<string>('MEDIA_ROOT').trim();
      this.businessValidation.assert(
        existsSync(root),
        `MEDIA_ROOT is not available: ${root}`,
      );

      const qb = this.episodeRep
        .createQueryBuilder('e')
        .select(['e.id', 'e.cartoonId', 'e.relativePath', 'e.durationSec'])
        .where('e.isActive = :active', { active: true });
      if (opts?.cartoonSlug) {
        qb.innerJoin(ChannelCartoon, 'c', 'c.id = e.cartoonId').andWhere(
          'c.slug = :slug',
          { slug: opts.cartoonSlug },
        );
      }
      const episodes = await qb.getMany();
      const changed = new Map<number, number>(); // episodeId → newSec

      type Outcome =
        | { kind: 'ok'; oldSec: number | null; newSec: number; ep: ChannelEpisode }
        | { kind: 'same'; ep: ChannelEpisode }
        | { kind: 'fail' };

      const outcomes = await mapLimit(
        episodes,
        DURATION_CONCURRENCY,
        async (episode): Promise<Outcome> => {
          const filePath = join(root, ...episode.relativePath.split('/'));
          const probed = await getVideoDurationSec(filePath);
          if (probed == null || probed < 1) return { kind: 'fail' };
          const newSec = Math.max(1, Math.round(probed));
          const oldSec = episode.durationSec;
          if (oldSec != null && Math.abs(oldSec - newSec) <= 1) {
            return { kind: 'same', ep: episode };
          }
          await this.episodeRep.update(episode.id, { durationSec: newSec });
          return { kind: 'ok', oldSec, newSec, ep: episode };
        },
      );

      for (const o of outcomes) {
        if (o.kind === 'fail') {
          failed += 1;
          continue;
        }
        if (o.kind === 'same') {
          unchanged += 1;
          // Keep map for schedule sync even when episode already matched file.
          if (o.ep.durationSec != null && o.ep.durationSec > 0) {
            changed.set(o.ep.id, o.ep.durationSec);
          }
          continue;
        }
        changed.set(o.ep.id, o.newSec);
        updated += 1;
        if (samples.length < 40) {
          samples.push({
            episodeId: o.ep.id,
            cartoonId: o.ep.cartoonId,
            relativePath: o.ep.relativePath,
            oldSec: o.oldSec,
            newSec: o.newSec,
          });
        }
      }

      if (syncSchedule && changed.size) {
        const tz = this.config.get<string>('AIR_TZ', 'Europe/Tallinn');
        const date = calendarDateInTz(tz);
        const ids = [...changed.keys()];
        // Batch IN — MariaDB handles thousands fine for a one-shot admin call.
        const items = await this.scheduleItemRep
          .createQueryBuilder('i')
          .innerJoin('i.scheduleDay', 'd')
          .where('d.date = :date', { date })
          .andWhere('i.episodeId IN (:...ids)', { ids })
          .getMany();
        for (const item of items) {
          const next = changed.get(item.episodeId);
          if (next == null || Math.abs(item.durationSec - next) <= 1) continue;
          await this.scheduleItemRep.update(item.id, { durationSec: next });
          scheduleItemsUpdated += 1;
          if (samples.length < 40) {
            samples.push({
              episodeId: item.episodeId,
              cartoonId: 0,
              relativePath: `schedule_item#${item.id}`,
              oldSec: item.durationSec,
              newSec: next,
            });
          }
        }
      }

      this.logger.log(
        `duration reprobe: probed=${episodes.length} updated=${updated} ` +
          `unchanged=${unchanged} failed=${failed} schedule=${scheduleItemsUpdated}`,
      );

      return {
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        probed: episodes.length,
        updated,
        unchanged,
        failed,
        scheduleItemsUpdated,
        samples,
      };
    } finally {
      this.scanning = false;
    }
  }

  private async fillMissingDurations(root: string) {
    const missing = await this.episodeRep.find({
      where: { durationSec: IsNull(), isActive: true },
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
    removed: ScanCounters,
    reactivated: ScanCounters,
    durations: { filled: number; failed: number },
    error: string | null,
  ): NonNullable<MediaScanStatus['lastScan']> {
    return {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      created,
      existing,
      removed,
      reactivated,
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
