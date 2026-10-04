import { Module } from '@nestjs/common';
import { StreamService } from './stream.service';
import { StreamEncodeService } from './stream-encode.service';
import { StreamRunEncodeService } from './stream-run-encode.service';
import { StreamController } from './stream.controller';
import { FfmpegService } from './ffmpeg.service';
import { StreamRealtimeService } from './stream-realtime.service';
import { StreamGateway } from './stream.gateway';
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
    StreamRealtimeService,
    StreamService,
    StreamGateway,
  ],
  exports: [FfmpegService, StreamRealtimeService],
})
export class StreamModule {}
