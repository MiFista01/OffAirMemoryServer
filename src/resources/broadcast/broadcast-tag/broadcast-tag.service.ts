import { Injectable } from '@nestjs/common';
import { CreateBroadcastTagDto } from './dto/create-broadcast-tag.dto';
import { UpdateBroadcastTagDto } from './dto/update-broadcast-tag.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { BroadcastTag } from '@entities';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class BroadcastTagService extends DefaultCRUDService<
  BroadcastTag,
  CreateBroadcastTagDto,
  UpdateBroadcastTagDto
> {
  constructor(
    @InjectRepository(BroadcastTag)
    private readonly broadcastTagRepository: Repository<BroadcastTag>,
  ) {
    super(broadcastTagRepository);
  }
}
