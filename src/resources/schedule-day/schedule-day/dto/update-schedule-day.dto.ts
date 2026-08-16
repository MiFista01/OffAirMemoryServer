import { PartialType } from '@nestjs/swagger';
import { CreateScheduleDayDto } from './create-schedule-day.dto';

export class UpdateScheduleDayDto extends PartialType(CreateScheduleDayDto) {}
