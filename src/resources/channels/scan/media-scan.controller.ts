import { Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@decorators';
import { MediaScanService } from './media-scan.service';

@ApiTags('Media')
@Controller('media')
export class MediaScanController {
  constructor(private readonly mediaScan: MediaScanService) {}

  @Public()
  @Get('status')
  @ApiOperation({
    summary: 'Process + catalog scan status (no restart needed)',
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
}
