import { Controller, Get, Post } from '@nestjs/common';
import { ScheduleDayService } from './schedule-day.service';
import { ParamDto, Public } from '@decorators';
import { ParamsNumbDto, ParamsSlugDto } from '@dtos';
import { todayUtcDate } from './schedule-day.builder';
import { ChannelsService } from 'src/resources/channels/channels/channels.service';
import { BusinessValidationService } from '@utils';

@Controller('schedule-day')
export class ScheduleDayController {
  constructor(
    private readonly scheduleDayService: ScheduleDayService,
    private readonly channels: ChannelsService,
    private readonly businessValidation: BusinessValidationService,
  ) {}

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

  @Public()
  @Get('channel/:channelId')
  findByChannelId(
    @ParamDto(ParamsNumbDto, 'channelId') channelId: number,
  ) {
    return this.scheduleDayService.findAllBySearch(
      { date: todayUtcDate(), channelId },
      ['scheduleItems', 'scheduleItems.episode'],
    );
  }

  @Public()
  @Get('channel/slug/:slug')
  async findByChannelSlug(@ParamDto(ParamsSlugDto, 'slug') slug: string) {
    const channel = await this.channels.findOne({ slug, isActive: true });
    this.businessValidation.assertExists(channel, 'Channel not found');
    return this.scheduleDayService.findAllBySearch(
      { date: todayUtcDate(), channelId: channel.id },
      ['scheduleItems', 'scheduleItems.episode'],
    );
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.scheduleDayService.findOne({ id });
  }
}
