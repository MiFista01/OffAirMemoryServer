import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { EpisodeService } from './episode.service';
import { CreateEpisodeDto } from './dto/create-episode.dto';
import { UpdateEpisodeDto } from './dto/update-episode.dto';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';

@Controller('episode')
export class EpisodeController {
  constructor(private readonly episodeService: EpisodeService) {}

  // @Post()
  // create(@Body() createEpisodeDto: CreateEpisodeDto) {
  //   return this.episodeService.create(createEpisodeDto);
  // }

  @Get()
  findAll() {
    return this.episodeService.findAll();
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.episodeService.findOne({ id });
  }

  // @Patch(':id')
  // update(
  //   @ParamDto(ParamsNumbDto, 'id') id: number,
  //   @Body() updateEpisodeDto: UpdateEpisodeDto) {
  //   return this.episodeService.update({ id }, updateEpisodeDto);
  // }

  // @Delete(':id')
  // remove(@ParamDto(ParamsNumbDto, 'id') id: number) {
  //   return this.episodeService.remove({ id });
  // }
}
