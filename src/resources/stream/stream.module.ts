import { Module } from '@nestjs/common';
import { StreamService } from './stream.service';
import { StreamController } from './stream.controller';
import { FfmpegService } from './ffmpeg.service';
import { ChannelsModule } from '../channels/channels/channels.module';
import { ScheduleDayModule } from '../schedule-day/schedule-day/schedule-day.module';

@Module({
  imports: [
    ChannelsModule,
    ScheduleDayModule
  ],
  controllers: [StreamController],
  providers: [StreamService, FfmpegService],
})
export class StreamModule {}
