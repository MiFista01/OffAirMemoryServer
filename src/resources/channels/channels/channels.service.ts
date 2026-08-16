import { Injectable } from '@nestjs/common';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { Channel } from '@entities';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class ChannelsService extends DefaultCRUDService
<
  Channel,
  CreateChannelDto,
  UpdateChannelDto 
> {

  constructor(
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
  ) {
    super(channelRepository);
  }
  
}
