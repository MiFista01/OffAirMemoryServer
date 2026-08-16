import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel, ChannelCartoon, ChannelEpisode } from '@entities';
import { MediaScanController } from './media-scan.controller';
import { MediaScanService } from './media-scan.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Channel, ChannelCartoon, ChannelEpisode]),
  ],
  controllers: [MediaScanController],
  providers: [MediaScanService],
  exports: [MediaScanService],
})
export class MediaScanModule {}
