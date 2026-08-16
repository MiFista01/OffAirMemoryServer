import { Controller, Get } from '@nestjs/common';
import { BroadcastWindowService } from './broadcast-window.service';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Broadcast windows')
@Controller('broadcast/windows')
export class BroadcastWindowController {
  constructor(
    private readonly broadcastWindowService: BroadcastWindowService,
  ) {}

  @Get()
  findAll() {
    return this.broadcastWindowService.findAll(['tag']);
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.broadcastWindowService.findOne({ id }, ['tag']);
  }
}
