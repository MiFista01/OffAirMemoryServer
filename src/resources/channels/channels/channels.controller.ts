import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Channels')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  // @Post()
  // create(@Body() createChannelDto: CreateChannelDto) {
  //   return this.channelsService.create(createChannelDto);
  // }

  @Get()
  findAll() {
    return this.channelsService.findAll();
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.channelsService.findOne({ id });
  }

  // @Patch(':id')
  // update(
  //   @ParamDto(ParamsNumbDto, 'id') id: number,
  //   @Body() updateChannelDto: UpdateChannelDto
  // ) {
  //   return this.channelsService.update({ id }, updateChannelDto);
  // }

  // @Delete(':id')
  // remove(@ParamDto(ParamsNumbDto, 'id') id: number) {
  //   return this.channelsService.remove({ id });
  // }
}
