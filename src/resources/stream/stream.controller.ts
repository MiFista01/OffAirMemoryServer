import { Controller, Delete, Get } from '@nestjs/common';
import { StreamService } from './stream.service';
import { ParamDto, Public, QueryDto } from '@decorators';
import { ApiOperation } from '@nestjs/swagger';
import { ParamsSlugDto, QueryStrDto, QueryStreamProfileDto } from '@dtos';
import { StreamProfile } from '@app-types';

@Controller('stream')
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  @Public()
  @Get(':slug/start')
  @ApiOperation({ summary: 'Start / reuse HLS for channel (Nginx serves /stream)' })
  start(
    @ParamDto(ParamsSlugDto, 'slug') slug: string,
    @QueryDto(QueryStrDto, 'tz') tz?: string,
    @QueryDto(QueryStreamProfileDto, 'profile') profile?: StreamProfile,
  ) {
    return this.streamService.start(slug, tz, profile);
  }

  @Public()
  @Delete(':slug/stop')
  @ApiOperation({ summary: 'Stop HLS job for channel+tz+profile' })
  stop(
    @ParamDto(ParamsSlugDto, 'slug') slug: string,
    @QueryDto(QueryStrDto, 'tz') tz?: string,
    @QueryDto(QueryStreamProfileDto, 'profile') profile?: StreamProfile,
  ) {
    return this.streamService.stop(slug, tz, profile);
  }
}
