import { Controller, Get } from '@nestjs/common';
import { BroadcastTagService } from './broadcast-tag.service';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Broadcast tags')
@Controller('broadcast/tags')
export class BroadcastTagController {
  constructor(private readonly broadcastTagService: BroadcastTagService) {}

  @Get()
  findAll() {
    return this.broadcastTagService.findAll(['windows']);
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.broadcastTagService.findOne({ id }, [
      'windows',
      'cartoons',
      'episodes',
    ]);
  }
}
