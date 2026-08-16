import { Injectable } from '@nestjs/common';
import { CreateCartoonDto } from './dto/create-cartoon.dto';
import { UpdateCartoonDto } from './dto/update-cartoon.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ChannelCartoon } from './entities/cartoon.entity';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class CartoonService extends DefaultCRUDService 
<
  ChannelCartoon,
  CreateCartoonDto,
  UpdateCartoonDto
> {

  constructor(
    @InjectRepository(ChannelCartoon)
    private readonly channelCartoonRepository: Repository<ChannelCartoon>,
  ) {
    super(channelCartoonRepository);
  }

  
}
