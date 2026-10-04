import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AirHistory, ChannelCartoon } from '@entities';
import { AirHistoryService } from './air-history.service';
import { AirHistoryController } from './air-history.controller';
import { EpisodeModule } from '../channels/episode/episode.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AirHistory, ChannelCartoon]),
    EpisodeModule,
  ],
  controllers: [AirHistoryController],
  providers: [AirHistoryService],
  exports: [AirHistoryService],
})
export class AirHistoryModule {}
