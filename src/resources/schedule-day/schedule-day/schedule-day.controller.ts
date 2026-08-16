import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ScheduleDayService } from './schedule-day.service';
import { CreateScheduleDayDto } from './dto/create-schedule-day.dto';
import { UpdateScheduleDayDto } from './dto/update-schedule-day.dto';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';

@Controller('schedule-day')
export class ScheduleDayController {
  constructor(private readonly scheduleDayService: ScheduleDayService) {}

  // @Post()
  // create(@Body() createScheduleDayDto: CreateScheduleDayDto) {
  //   return this.scheduleDayService.create(createScheduleDayDto);
  // }

  @Get()
  findAll() {
    return this.scheduleDayService.findAll();
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
