import { Injectable } from '@nestjs/common';
import { CreateScheduleDayDto } from './dto/create-schedule-day.dto';
import { UpdateScheduleDayDto } from './dto/update-schedule-day.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ScheduleDay } from '@entities';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class ScheduleDayService extends DefaultCRUDService 
<
  ScheduleDay,
  CreateScheduleDayDto,
  UpdateScheduleDayDto
> {
  constructor(
    @InjectRepository(ScheduleDay)
    private readonly scheduleDayRepository: Repository<ScheduleDay>,
  ) {
    super(scheduleDayRepository);
  }

  createDaySchedule() {
    
  }
}
