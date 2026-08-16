import { Module } from '@nestjs/common';
import { BroadcastTagModule } from './broadcast-tag/broadcast-tag.module';
import { BroadcastWindowModule } from './broadcast-window/broadcast-window.module';

@Module({
  imports: [BroadcastTagModule, BroadcastWindowModule],
  exports: [BroadcastTagModule, BroadcastWindowModule],
})
export class BroadcastModule {}
