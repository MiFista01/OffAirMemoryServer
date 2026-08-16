import { PartialType } from '@nestjs/swagger';
import { CreateScheduleItemDto } from './create-schedule-item.dto';

export class UpdateScheduleItemDto extends PartialType(CreateScheduleItemDto) {}
