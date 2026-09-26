import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIR_WINDOW_START } from '@constants';
import { ChannelsService } from '../channels/channels/channels.service';
import { ScheduleDayService } from '../schedule-day/schedule-day/schedule-day.service';
import { todayUtcDate } from '../schedule-day/schedule-day/schedule-day.builder';
import { FfmpegService } from './ffmpeg.service';
import { BusinessValidationService } from '@utils';
import {
  findRemainingPlaylist,
  streamFolderName,
  windowStartAt,
} from './stream-air.util';
import { join } from 'path';

type HlsSegmentInput = {
  path: string;
  inpointSec: number;
  durationSec: number;
};

@Injectable()
export class StreamService {
  constructor(
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly scheduleDays: ScheduleDayService,
    private readonly ffmpeg: FfmpegService,
    private readonly businessValidation: BusinessValidationService,
  ) {}

  async start(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const mediaRoot = this.config.getOrThrow<string>('MEDIA_ROOT');
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT');
    const channel = await this.channels.findOne({ slug, isActive: true });
    this.businessValidation.assertExists(channel, 'Channel not found');
    this.businessValidation.assert(channel.isActive, 'Channel is not active');

    // Same date key as schedule cron (UTC calendar day)
    const date = todayUtcDate();
    const day = await this.scheduleDays.findOne(
      { channelId: channel.id, date },
      ['scheduleItems', 'scheduleItems.episode'],
    );
    this.businessValidation.assertExists(day, 'No schedule for today');

    const airStart = windowStartAt(date, AIR_WINDOW_START, tz);
    const segments = findRemainingPlaylist(day.scheduleItems, airStart);
    this.businessValidation.assertNotEmpty(segments, 'Channel is off air');

    const hlsSegments: HlsSegmentInput[] = segments.map((seg) => {
      const ep = seg.item.episode;
      this.businessValidation.assertExists(ep, 'Episode file missing');
      return {
        path: join(mediaRoot, ...ep.relativePath.split('/')),
        inpointSec: seg.inpointSec,
        durationSec: seg.durationSec,
      };
    });

    const key = `${slug}:${tz}:${profile}`;
    const job = await this.ffmpeg.startHls({
      key,
      streamRoot,
      folderName: streamFolderName(slug, tz, profile),
      segments: hlsSegments,
    });

    const first = segments[0];
    return {
      channel: slug,
      streamUrl: job.playlistUrl,
      episodeId: first.item.episode.id,
      offsetSec: first.inpointSec,
      source: first.item.source,
      remainingCount: segments.length,
    };
  }

  stop(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    const stopped = this.ffmpeg.stop(key);
    return { channel: slug, key, stopped };
  }
}
