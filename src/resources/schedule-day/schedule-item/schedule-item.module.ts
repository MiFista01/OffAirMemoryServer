import { Module } from '@nestjs/common';
import { ScheduleItemService } from './schedule-item.service';
import { ScheduleItemController } from './schedule-item.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleItem } from '@entities';

@Module({
  imports: [TypeOrmModule.forFeature([ScheduleItem])],
  controllers: [ScheduleItemController],
  providers: [ScheduleItemService],
  exports: [ScheduleItemService],
})
export class ScheduleItemModule {}
