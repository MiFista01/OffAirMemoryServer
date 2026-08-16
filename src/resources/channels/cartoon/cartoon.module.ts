import { Module } from '@nestjs/common';
import { CartoonService } from './cartoon.service';
import { CartoonController } from './cartoon.controller';
import { ChannelCartoon } from '@entities';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule.forFeature([ChannelCartoon])],
  controllers: [CartoonController],
  providers: [CartoonService],
  exports: [CartoonService],
})
export class CartoonModule {}
