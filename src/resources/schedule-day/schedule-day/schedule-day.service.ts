import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateScheduleDayDto } from './dto/create-schedule-day.dto';
import { UpdateScheduleDayDto } from './dto/update-schedule-day.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ScheduleDay } from '@entities';
import { LessThan, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelsService } from 'src/resources/channels/channels/channels.service';
import { CartoonService } from 'src/resources/channels/cartoon/cartoon.service';
import { AIR_TIME_HOURS, AIR_WINDOW_START } from '@constants';
import { ScheduleItemService } from '../schedule-item/schedule-item.service';
import {
  buildDayPlaylist,
  shiftYmd,
  todayUtcDate,
} from './schedule-day.builder';
import { AirHistoryService } from 'src/resources/air-history/air-history.service';
import {
  calendarDateInTz,
  windowStartAt,
} from 'src/resources/stream/stream-air.util';

export type GuideSlotDto = {
  order: number;
  episodeId: number;
  durationSec: number;
  startAt: string;
  endAt: string;
  title: string;
  seasonNumber: number;
  episodeNumber: number;
  cartoonSlug: string | null;
  source: string;
};

export type GuideChannelDto = {
  id: number;
  slug: string;
  name: string;
  slots: GuideSlotDto[];
};

@Injectable()
export class ScheduleDayService
  extends DefaultCRUDService<
    ScheduleDay,
    CreateScheduleDayDto,
    UpdateScheduleDayDto
  >
  implements OnModuleInit
{
  private readonly logger = new Logger(ScheduleDayService.name);

  constructor(
    @InjectRepository(ScheduleDay)
    scheduleDayRepository: Repository<ScheduleDay>,
    private readonly scheduleItemService: ScheduleItemService,
    private readonly channelService: ChannelsService,
    private readonly cartoonService: CartoonService,
    private readonly config: ConfigService,
    private readonly airHistory: AirHistoryService,
  ) {
    super(scheduleDayRepository);
  }

  private airTimeSec(): number {
    const hours = Number(
      this.config.get<string | number>('AIR_TIME_HOURS', AIR_TIME_HOURS),
    );
    return (Number.isFinite(hours) ? hours : AIR_TIME_HOURS) * 60 * 60;
  }

  private airWindowStart(): string {
    return this.config.get<string>('AIR_WINDOW_START', AIR_WINDOW_START);
  }

  /**
   * EPG payload: all active channels + timed slots for the local air day.
   * Times are absolute ISO so the client can draw the "now" line without tz math.
   */
  async getTodayGuide(tz = 'Europe/Tallinn') {
    const airWindowStart = this.airWindowStart();
    const airTimeHours = this.airTimeSec() / 3600;
    const localDate = calendarDateInTz(tz);
    const utcDate = todayUtcDate();
    const airStart = windowStartAt(localDate, airWindowStart, tz);
    const channels = await this.channelService.findAllBySearch({
      isActive: true,
    });

    const out: GuideChannelDto[] = [];
    for (const channel of channels) {
      let day = await this.findOne(
        { date: localDate, channelId: channel.id },
        [
          'scheduleItems',
          'scheduleItems.episode',
          'scheduleItems.episode.cartoon',
        ],
      );
      if (!day && utcDate !== localDate) {
        day = await this.findOne(
          { date: utcDate, channelId: channel.id },
          [
            'scheduleItems',
            'scheduleItems.episode',
            'scheduleItems.episode.cartoon',
          ],
        );
      }
      const raw = [...(day?.scheduleItems ?? [])].sort(
        (a, b) => a.order - b.order,
      );
      let cursor = airStart.getTime();
      const slots: GuideSlotDto[] = raw.map((item) => {
        const startMs = cursor;
        const endMs = cursor + Math.max(1, item.durationSec) * 1000;
        cursor = endMs;
        const ep = item.episode;
        const cartoon = ep?.cartoon;
        return {
          order: item.order,
          episodeId: item.episodeId,
          durationSec: item.durationSec,
          startAt: new Date(startMs).toISOString(),
          endAt: new Date(endMs).toISOString(),
          title: cartoon?.name ?? ep?.title ?? ep?.relativePath ?? '—',
          seasonNumber: ep?.seasonNumber ?? 0,
          episodeNumber: ep?.episodeNumber ?? 0,
          cartoonSlug: cartoon?.slug ?? null,
          source: item.source ?? 'regular',
        };
      });
      out.push({
        id: channel.id,
        slug: channel.slug,
        name: channel.name,
        slots,
      });
    }

    return {
      date: localDate,
      tz,
      airWindowStart,
      airTimeHours,
      airStartAt: airStart.toISOString(),
      channels: out,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async createDaySchedule() {
    // Guide/stream use local air TZ — not UTC calendar day (midnight UTC ≠ Tallinn).
    const tz = this.config.get<string>('AIR_TZ', 'Europe/Tallinn');
    const date = calendarDateInTz(tz);
    const airTimeSec = this.airTimeSec();
    const channels = await this.channelService.findAllBySearch({
      isActive: true,
    });

    if (!channels.length) {
      this.logger.warn(
        `createDaySchedule(${date}): no active channels — activate channels/cartoons after scan`,
      );
      try {
        await this.purgeOldScheduleDays();
      } catch (e) {
        this.logger.warn(`purgeOldScheduleDays failed: ${e}`);
      }
      return { date, channels: 0, created: 0 };
    }

    let created = 0;
    for (const channel of channels) {
      try {
        const made = await this.createChannelDay(channel.id, date, airTimeSec);
        if (made) created += 1;
      } catch (e) {
        this.logger.warn(
          `createChannelDay channel=${channel.id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    this.logger.log(
      `createDaySchedule(${date}): activeChannels=${channels.length} daysCreated=${created}`,
    );
    // New day is additive — old days stay until purged (guide only loads today).
    let purged = 0;
    try {
      purged = await this.purgeOldScheduleDays();
    } catch (e) {
      this.logger.warn(`purgeOldScheduleDays failed: ${e}`);
    }
    return { date, channels: channels.length, created, purged };
  }

  /**
   * Drop schedule days older than keepDays (default 7) before today in AIR_TZ.
   * createDaySchedule only inserts missing today — it never replaces history.
   */
  async purgeOldScheduleDays(keepDays = 7): Promise<number> {
    const tz = this.config.get<string>('AIR_TZ', 'Europe/Tallinn');
    const today = calendarDateInTz(tz);
    const keep = Math.max(1, Math.floor(keepDays));
    const cutoff = shiftYmd(today, -keep);
    // LessThan directly — DefaultCRUD turns string values into Like before 'date<' ops.
    const oldDays = await this.getRepo().find({
      where: { date: LessThan(cutoff) },
      select: ['id'],
    });
    if (!oldDays.length) return 0;

    const dayIds = oldDays.map((d) => d.id);
    await this.scheduleItemService.remove({ scheduleDayId: dayIds });
    await this.remove({ id: dayIds });
    this.logger.log(
      `purgeOldScheduleDays: removed ${dayIds.length} day(s) before ${cutoff} (keep ${keep}d)`,
    );
    return dayIds.length;
  }

  /**
   * Boot / after scan: fill missing days for today.
   * Safe to call repeatedly — skips channels that already have a day.
   */
  async onModuleInit() {
    try {
      await this.createDaySchedule();
    } catch (e) {
      // Never crash Nest boot — TV can still serve yesterday until cron/manual rebuild.
      this.logger.error(
        `onModuleInit createDaySchedule failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private async createChannelDay(
    channelId: number,
    date: string,
    airTimeSec: number,
  ): Promise<boolean> {
    const existing = await this.findOne({ date, channelId }, [
      'scheduleItems',
    ]);
    if (existing) {
      // Orphan day (create succeeded, items failed) — rebuild instead of skip.
      if (!existing.scheduleItems?.length) {
        this.logger.warn(
          `createChannelDay channel=${channelId} date=${date}: empty day — rebuild`,
        );
        await this.scheduleItemService.remove({
          scheduleDayId: existing.id,
        });
        await this.remove(existing.id);
      } else {
        return false;
      }
    }

    const cartoons = await this.cartoonService.findAllBySearch(
      { channelId, isActive: true },
      [
        'episodes',
        'broadcastTags',
        'broadcastTags.windows',
        'episodes.broadcastTags',
        'episodes.broadcastTags.windows',
      ],
    );

    if (!cartoons.length) {
      this.logger.warn(
        `createChannelDay channel=${channelId} date=${date}: no active cartoons`,
      );
      return false;
    }

    // Air history → cursors: Jack was aired → next after the last one in the log.
    // Tags / holiday / franchise roulette — unchanged in buildDayPlaylist.
    const latest = await this.airHistory.latestByCartoon(channelId);
    this.airHistory.applyHistoryToCursors(cartoons, latest);

    // Day + items + cursor bumps in one TX — partial failure must not leave a
    // filled day with half-advanced cursors (re-run would skip forever).
    return this.getRepo().manager.transaction(async (manager) => {
      const scheduleDay = await this.create({ date, channelId }, manager);
      const { items, cursorTouched } = buildDayPlaylist(
        scheduleDay.id,
        channelId,
        date,
        cartoons,
        airTimeSec,
      );

      if (!items.length) {
        this.logger.warn(
          `createChannelDay channel=${channelId} date=${date}: empty playlist (need active cartoons with durationSec)`,
        );
        await this.remove(scheduleDay.id, manager);
        return false;
      }

      await this.scheduleItemService.createBulk({ entities: items }, manager);
      for (const cartoon of cursorTouched.values()) {
        await this.cartoonService.update(
          cartoon.id,
          {
            cursorSeason: cartoon.cursorSeason,
            cursorEpisode: cartoon.cursorEpisode,
          },
          manager,
        );
      }
      return true;
    });
  }
}
