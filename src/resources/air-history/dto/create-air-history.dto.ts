import { AirHistoryOrigin, AirHistorySource } from '../entities/air-history.entity';

export class CreateAirHistoryDto {
  channelId: number;
  cartoonId: number;
  episodeId: number;
  date: string;
  finishedAt?: Date | string;
  source?: AirHistorySource;
  seasonNumber?: number;
  episodeNumber?: number;
  scheduleItemId?: number | null;
  scheduleDayId?: number | null;
  origin?: AirHistoryOrigin;
}
