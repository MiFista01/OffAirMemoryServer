import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { Channel } from '@entities';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CartoonModule } from '../cartoon/cartoon.module';
import { EpisodeModule } from '../episode/episode.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Channel]),
    CartoonModule,
    EpisodeModule
  ],
  controllers: [ChannelsController],
  providers: [ChannelsService],
})
export class ChannelsModule {}
