import { Injectable } from '@nestjs/common';
import { CreateEpisodeDto } from './dto/create-episode.dto';
import { UpdateEpisodeDto } from './dto/update-episode.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ChannelEpisode } from '@entities';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class EpisodeService extends DefaultCRUDService 
<
  ChannelEpisode,
  CreateEpisodeDto,
  UpdateEpisodeDto
> {
  constructor(
    @InjectRepository(ChannelEpisode)
    private readonly channelEpisodeRepository: Repository<ChannelEpisode>,
  ) {
    super(channelEpisodeRepository);
  }
}
