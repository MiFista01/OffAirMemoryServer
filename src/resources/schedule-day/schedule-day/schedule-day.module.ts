import { Module } from '@nestjs/common';
import { ScheduleDayService } from './schedule-day.service';
import { ScheduleDayController } from './schedule-day.controller';
import { ScheduleDay } from '@entities';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleItemModule } from '../schedule-item/schedule-item.module';
import { ChannelsModule } from 'src/resources/channels/channels/channels.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduleDay]),
    ScheduleItemModule,
    ChannelsModule,
  ],
  controllers: [ScheduleDayController],
  providers: [ScheduleDayService],
  exports: [ScheduleDayService],
})
export class ScheduleDayModule {}
