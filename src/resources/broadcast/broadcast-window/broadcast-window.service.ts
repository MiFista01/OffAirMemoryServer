import { Injectable } from '@nestjs/common';
import { CreateBroadcastWindowDto } from './dto/create-broadcast-window.dto';
import { UpdateBroadcastWindowDto } from './dto/update-broadcast-window.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { BroadcastWindow } from '@entities';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class BroadcastWindowService extends DefaultCRUDService<
  BroadcastWindow,
  CreateBroadcastWindowDto,
  UpdateBroadcastWindowDto
> {
  constructor(
    @InjectRepository(BroadcastWindow)
    private readonly broadcastWindowRepository: Repository<BroadcastWindow>,
  ) {
    super(broadcastWindowRepository);
  }
}
