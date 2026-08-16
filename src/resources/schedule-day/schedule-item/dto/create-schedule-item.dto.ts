import { ScheduleItemSource } from '@entities';

export class CreateScheduleItemDto {
  scheduleDayId: number;
  episodeId: number;
  order: number;
  durationSec: number;
  source?: ScheduleItemSource;
}
