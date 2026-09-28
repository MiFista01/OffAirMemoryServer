import { Controller, Delete, Get, Query, Req } from '@nestjs/common';
import { StreamService } from './stream.service';
import { FfmpegService } from './ffmpeg.service';
import { ParamDto, Public, QueryDto } from '@decorators';
import { ApiOperation } from '@nestjs/swagger';
import { ParamsSlugDto, QueryStrDto, QueryStreamProfileDto } from '@dtos';
import { StreamProfile } from '@app-types';
import { Request } from 'express';

@Controller('stream')
export class StreamController {
  constructor(
    private readonly streamService: StreamService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  @Public()
  @Get('hls-touch')
  @ApiOperation({
    summary: 'Internal/nginx: touch encode by HLS folder name',
  })
  hlsTouch(@Query('folder') folder?: string) {
    if (!folder) return { ok: false };
    return { ok: this.ffmpeg.touchByFolder(folder) };
  }

  @Public()
  @Get(':slug/start')
  @ApiOperation({ summary: 'Start / reuse HLS for channel' })
  async start(
    @Req() req: Request,
    @ParamDto(ParamsSlugDto, 'slug') slug: string,
    @QueryDto(QueryStrDto, 'tz') tz?: string,
    @QueryDto(QueryStreamProfileDto, 'profile') profile?: StreamProfile,
  ) {
    const result = await this.streamService.start(slug, tz, profile);
    return {
      ...result,
      // Absolute URL — Angular just plays it (Nest or nginx behind same host)
      streamUrl: this.absoluteStreamUrl(req, result.streamUrl),
    };
  }

  @Public()
  @Get(':slug/status')
  @ApiOperation({
    summary: 'HLS ready? Poll while start returns status=starting',
  })
  async status(
    @Req() req: Request,
    @ParamDto(ParamsSlugDto, 'slug') slug: string,
    @QueryDto(QueryStrDto, 'tz') tz?: string,
    @QueryDto(QueryStreamProfileDto, 'profile') profile?: StreamProfile,
  ) {
    const result = await this.streamService.status(slug, tz, profile);
    return {
      ...result,
      streamUrl: this.absoluteStreamUrl(req, result.streamUrl),
    };
  }

  @Public()
  @Get(':slug/heartbeat')
  @ApiOperation({
    summary: 'Viewer heartbeat — keep ffmpeg alive while watching',
  })
  heartbeat(
    @ParamDto(ParamsSlugDto, 'slug') slug: string,
    @QueryDto(QueryStrDto, 'tz') tz?: string,
    @QueryDto(QueryStreamProfileDto, 'profile') profile?: StreamProfile,
  ) {
    return this.streamService.heartbeat(slug, tz, profile);
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

  private absoluteStreamUrl(req: Request, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto =
      (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0];
    return `${proto}://${host}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
