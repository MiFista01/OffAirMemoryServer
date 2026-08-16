import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ScheduleDayService } from './schedule-day.service';
import { CreateScheduleDayDto } from './dto/create-schedule-day.dto';
import { UpdateScheduleDayDto } from './dto/update-schedule-day.dto';
import { ParamDto, Public } from '@decorators';
import { ParamsNumbDto, ParamsSlugDto } from '@dtos';
import { todayUtcDate } from './schedule-day.builder';

@Controller('schedule-day')
export class ScheduleDayController {
  constructor(private readonly scheduleDayService: ScheduleDayService) {}

  @Post('create-day-schedule')
  @Public()
  createDaySchedule() {
    return this.scheduleDayService.createDaySchedule();
  }

  @Get('channel/:channel-id')
  @Public()
  findAll(@ParamDto(ParamsNumbDto, 'channel-id') channelId: number) {
    return this.scheduleDayService.findAllBySearch(
      {date: todayUtcDate(), channelId},
      ['scheduleItems.episode']
    );
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.scheduleDayService.findOne({ id });
  }

  // @Patch(':id')
  // update(
  //   @ParamDto(ParamsNumbDto, 'id') id: number,
  //   @Body() updateScheduleDayDto: UpdateScheduleDayDto) {
  //   return this.scheduleDayService.update({ id }, updateScheduleDayDto);
  // }

  // @Delete(':id')
  // remove(@ParamDto(ParamsNumbDto, 'id') id: number) {
  //   return this.scheduleDayService.remove({ id });
  // }
}
