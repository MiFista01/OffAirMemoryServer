import { Module } from '@nestjs/common';
import { StreamService } from './stream.service';
import { StreamEncodeService } from './stream-encode.service';
import { StreamRunEncodeService } from './stream-run-encode.service';
import { StreamController } from './stream.controller';
import { FfmpegService } from './ffmpeg.service';
import { ChannelsModule } from '../channels/channels/channels.module';
import { ScheduleDayModule } from '../schedule-day/schedule-day/schedule-day.module';
import { AirHistoryModule } from '../air-history/air-history.module';

@Module({
  imports: [ChannelsModule, ScheduleDayModule, AirHistoryModule],
  controllers: [StreamController],
  providers: [
    FfmpegService,
    StreamRunEncodeService,
    StreamEncodeService,
    StreamService,
  ],
  exports: [FfmpegService],
})
export class StreamModule {}
