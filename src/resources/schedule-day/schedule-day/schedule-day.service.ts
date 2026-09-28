import { Injectable, OnModuleInit } from '@nestjs/common';
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
import { AIR_TIME_HOURS } from '@constants';
import { ScheduleItemService } from '../schedule-item/schedule-item.service';
import { buildDayPlaylist, todayUtcDate } from './schedule-day.builder';
import { AirHistoryService } from 'src/resources/air-history/air-history.service';

@Injectable()
export class ScheduleDayService
  extends DefaultCRUDService<
    ScheduleDay,
    CreateScheduleDayDto,
    UpdateScheduleDayDto
  >
  implements OnModuleInit
{
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

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async createDaySchedule() {
    const date = todayUtcDate();
    const airTimeSec = this.airTimeSec();
    const channels = await this.channelService.findAllBySearch({
      isActive: true,
    });

    for (const channel of channels) {
      await this.createChannelDay(channel.id, date, airTimeSec);
    }
  }

  async onModuleInit() {
    const date = todayUtcDate();
    if (await this.findOne({ date })) return;
    await this.createDaySchedule();
  }

  private async createChannelDay(
    channelId: number,
    date: string,
    airTimeSec: number,
  ) {
    if (await this.findOne({ date, channelId })) return;

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

    // История эфира → курсоры: выпал Джек → следующая после последней в логе.
    // Теги / holiday / franchise roulette — без изменений в buildDayPlaylist.
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
      await this.remove(scheduleDay.id);
      return;
    }

    await this.scheduleItemService.createBulk({ entities: items });
    for (const cartoon of cursorTouched.values()) {
      await this.cartoonService.update(cartoon.id, {
        cursorSeason: cartoon.cursorSeason,
        cursorEpisode: cartoon.cursorEpisode,
      });
    }
  }
}
