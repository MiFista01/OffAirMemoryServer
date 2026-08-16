import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ScheduleItemService } from './schedule-item.service';
import { CreateScheduleItemDto } from './dto/create-schedule-item.dto';
import { UpdateScheduleItemDto } from './dto/update-schedule-item.dto';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';

@Controller('schedule-item')
export class ScheduleItemController {
  constructor(private readonly scheduleItemService: ScheduleItemService) {}

  // @Post()
  // create(@Body() createScheduleItemDto: CreateScheduleItemDto) {
  //   return this.scheduleItemService.create(createScheduleItemDto);
  // }

  @Get()
  findAll() {
    return this.scheduleItemService.findAll();
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.scheduleItemService.findOne({ id });
  }

  // @Patch(':id')
  // update(
  //   @ParamDto(ParamsNumbDto, 'id') id: number,
  //   @Body() updateScheduleItemDto: UpdateScheduleItemDto) {
  //   return this.scheduleItemService.update({ id }, updateScheduleItemDto);
  // }

  // @Delete(':id')
  // remove(@ParamDto(ParamsNumbDto, 'id') id: number) {
  //   return this.scheduleItemService.remove({ id });
  // }
}
