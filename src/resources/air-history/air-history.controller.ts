import { Controller, Get } from '@nestjs/common';
import { AirHistoryService } from './air-history.service';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('air-history')
@Controller('air-history')
export class AirHistoryController {
  constructor(private readonly airHistoryService: AirHistoryService) {}

  @Get()
  @ApiOperation({ summary: 'List air history (all)' })
  findAll() {
    return this.airHistoryService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One air history row' })
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.airHistoryService.findOne({ id });
  }
}
