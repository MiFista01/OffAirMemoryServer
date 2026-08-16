import { Module } from '@nestjs/common';
import { BroadcastWindowService } from './broadcast-window.service';
import { BroadcastWindowController } from './broadcast-window.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BroadcastWindow } from '@entities';

@Module({
  imports: [TypeOrmModule.forFeature([BroadcastWindow])],
  controllers: [BroadcastWindowController],
  providers: [BroadcastWindowService],
  exports: [BroadcastWindowService],
})
export class BroadcastWindowModule {}
