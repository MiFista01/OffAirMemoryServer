import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel, ChannelCartoon, ChannelEpisode } from '@entities';
import { MediaScanController } from './media-scan.controller';
import { MediaScanService } from './media-scan.service';
import { ScheduleDayModule } from 'src/resources/schedule-day/schedule-day/schedule-day.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Channel, ChannelCartoon, ChannelEpisode]),
    forwardRef(() => ScheduleDayModule),
  ],
  controllers: [MediaScanController],
  providers: [MediaScanService],
  exports: [MediaScanService],
})
export class MediaScanModule {}
