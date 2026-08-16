import { Injectable } from '@nestjs/common';
import { CreateScheduleItemDto } from './dto/create-schedule-item.dto';
import { UpdateScheduleItemDto } from './dto/update-schedule-item.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ScheduleItem } from '@entities';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class ScheduleItemService extends DefaultCRUDService 
<
  ScheduleItem,
  CreateScheduleItemDto,
  UpdateScheduleItemDto
> {
  constructor(
    @InjectRepository(ScheduleItem)
    private readonly scheduleItemRepository: Repository<ScheduleItem>,
  ) {
    super(scheduleItemRepository);
  }

}
