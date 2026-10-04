import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '@decorators';
import { MediaScanService } from './media-scan.service';

@ApiTags('Media')
@Controller('media')
export class MediaScanController {
  constructor(private readonly mediaScan: MediaScanService) {}

  @Public()
  @Get('status')
  @ApiOperation({
    summary: 'Process + media scan status (no restart needed)',
  })
  getStatus() {
    return this.mediaScan.getStatus();
  }

  @Public()
  @Post('scan')
  @ApiOperation({ summary: 'Register channels / cartoons / episodes from MEDIA_ROOT' })
  scan() {
    return this.mediaScan.scan();
  }

  @Public()
  @Post('durations/reprobe')
  @ApiOperation({
    summary:
      'Re-ffprobe episode files and fix durationSec (+ today schedule slots)',
  })
  @ApiQuery({
    name: 'cartoon',
    required: false,
    description: 'Cartoon slug filter, e.g. incredible-hulk',
  })
  @ApiQuery({
    name: 'syncSchedule',
    required: false,
    description: 'Also rewrite today schedule_item.durationSec (default true)',
  })
  reprobeDurations(
    @Query('cartoon') cartoon?: string,
    @Query('syncSchedule') syncSchedule?: string,
  ) {
    const sync =
      syncSchedule == null
        ? true
        : !['0', 'false', 'no'].includes(syncSchedule.toLowerCase());
    return this.mediaScan.reprobeDurations({
      cartoonSlug: cartoon?.trim() || undefined,
      syncSchedule: sync,
    });
  }
}
