import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleDay } from '@entities';
import { ScheduleDayService } from './schedule-day.service';
import { ScheduleDayController } from './schedule-day.controller';
import { ScheduleItemModule } from '../schedule-item/schedule-item.module';
import { ChannelsModule } from 'src/resources/channels/channels/channels.module';
import { AirHistoryModule } from 'src/resources/air-history/air-history.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduleDay]),
    ScheduleItemModule,
    ChannelsModule,
    AirHistoryModule,
  ],
  controllers: [ScheduleDayController],
  providers: [ScheduleDayService],
  exports: [ScheduleDayService],
})
export class ScheduleDayModule {}
