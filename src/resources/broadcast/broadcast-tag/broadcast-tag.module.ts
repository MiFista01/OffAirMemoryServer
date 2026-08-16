import { Module } from '@nestjs/common';
import { BroadcastTagService } from './broadcast-tag.service';
import { BroadcastTagController } from './broadcast-tag.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BroadcastTag } from '@entities';

@Module({
  imports: [TypeOrmModule.forFeature([BroadcastTag])],
  controllers: [BroadcastTagController],
  providers: [BroadcastTagService],
  exports: [BroadcastTagService],
})
export class BroadcastTagModule {}
