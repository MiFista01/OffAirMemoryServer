import { Controller, Get, Post, Query } from '@nestjs/common';
import { ScheduleDayService } from './schedule-day.service';
import { ParamDto, Public } from '@decorators';
import { ParamsNumbDto, ParamsSlugDto } from '@dtos';
import { ChannelsService } from 'src/resources/channels/channels/channels.service';
import { BusinessValidationService } from '@utils';
import { ConfigService } from '@nestjs/config';
import { calendarDateInTz } from 'src/resources/stream/stream-air.util';

@Controller('schedule-day')
export class ScheduleDayController {
  constructor(
    private readonly scheduleDayService: ScheduleDayService,
    private readonly channels: ChannelsService,
    private readonly businessValidation: BusinessValidationService,
    private readonly config: ConfigService,
  ) {}

  private airDate(): string {
    return calendarDateInTz(this.airDateTz());
  }

  /** Build today's playlists for all active channels (idempotent). */
  @Public()
  @Post('create-day-schedule')
  createDaySchedulePost() {
    return this.scheduleDayService.createDaySchedule();
  }

  /** Same as POST — handy from browser address bar. */
  @Public()
  @Get('create-day-schedule')
  createDayScheduleGet() {
    return this.scheduleDayService.createDaySchedule();
  }

  /** TV guide / EPG: all channels + timed slots for the air day. */
  @Public()
  @Get('guide/today')
  guideToday(@Query('tz') _tz?: string) {
    // Always station AIR_TZ — browser TZ would shift the "now" line vs encode.
    return this.scheduleDayService.getTodayGuide(this.airDateTz());
  }

  private airDateTz(): string {
    return this.config.get<string>('AIR_TZ', 'Europe/Tallinn');
  }

  @Public()
  @Get('channel/:channelId')
  findByChannelId(
    @ParamDto(ParamsNumbDto, 'channelId') channelId: number,
  ) {
    return this.scheduleDayService.findAllBySearch(
      { date: this.airDate(), channelId },
      [
        'scheduleItems',
        'scheduleItems.episode',
        'scheduleItems.episode.cartoon',
      ],
    );
  }

  @Public()
  @Get('channel/slug/:slug')
  async findByChannelSlug(@ParamDto(ParamsSlugDto, 'slug') slug: string) {
    const channel = await this.channels.findOne({ slug, isActive: true });
    this.businessValidation.assertExists(channel, 'Channel not found');
    return this.scheduleDayService.findAllBySearch(
      { date: this.airDate(), channelId: channel.id },
      [
        'scheduleItems',
        'scheduleItems.episode',
        'scheduleItems.episode.cartoon',
      ],
    );
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.scheduleDayService.findOne({ id });
  }
}
