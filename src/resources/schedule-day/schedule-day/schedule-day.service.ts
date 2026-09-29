import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateScheduleDayDto } from './dto/create-schedule-day.dto';
import { UpdateScheduleDayDto } from './dto/update-schedule-day.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ScheduleDay } from '@entities';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelsService } from 'src/resources/channels/channels/channels.service';
import { CartoonService } from 'src/resources/channels/cartoon/cartoon.service';
import { AIR_TIME_HOURS, AIR_WINDOW_START } from '@constants';
import { ScheduleItemService } from '../schedule-item/schedule-item.service';
import { buildDayPlaylist, todayUtcDate } from './schedule-day.builder';
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
    const date = todayUtcDate();
    const airTimeSec = this.airTimeSec();
    const channels = await this.channelService.findAllBySearch({
      isActive: true,
    });

    if (!channels.length) {
      this.logger.warn(
        `createDaySchedule(${date}): no active channels — activate channels/cartoons after scan`,
      );
      return { date, channels: 0, created: 0 };
    }

    let created = 0;
    for (const channel of channels) {
      const made = await this.createChannelDay(channel.id, date, airTimeSec);
      if (made) created += 1;
    }
    this.logger.log(
      `createDaySchedule(${date}): activeChannels=${channels.length} daysCreated=${created}`,
    );
    return { date, channels: channels.length, created };
  }

  /**
   * Boot / after scan: fill missing days for today.
   * Safe to call repeatedly — skips channels that already have a day.
   */
  async onModuleInit() {
    await this.createDaySchedule();
  }

  private async createChannelDay(
    channelId: number,
    date: string,
    airTimeSec: number,
  ): Promise<boolean> {
    if (await this.findOne({ date, channelId })) return false;

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

    const scheduleDay = await this.create({ date, channelId });
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
      await this.remove(scheduleDay.id);
      return false;
    }

    await this.scheduleItemService.createBulk({ entities: items });
    for (const cartoon of cursorTouched.values()) {
      await this.cartoonService.update(cartoon.id, {
        cursorSeason: cartoon.cursorSeason,
        cursorEpisode: cartoon.cursorEpisode,
      });
    }
    return true;
  }
}
