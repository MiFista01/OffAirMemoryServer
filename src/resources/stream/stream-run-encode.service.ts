import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIR_WINDOW_START } from '@constants';
import { ChannelsService } from '../channels/channels/channels.service';
import { FfmpegService } from './ffmpeg.service';
import { BusinessValidationService } from '@utils';
import {
  readAirFinish,
  writeAirFinish,
} from './air-finish.state';
import {
  calendarDateInTz,
  findPlaylistAfterCompleted,
  findRemainingPlaylist,
  isFinishingOverrun,
  isWithinAirWindow,
  streamFolderName,
  trimPlaylistToAirEnd,
  windowStartAt,
} from './stream-air.util';
import { join } from 'path';
import {
  clampSegmentsToFile,
  capLookahead,
  type HlsSegmentInput,
} from './stream-encode.helpers';
import type {
  StreamRunEncodeHost,
  StreamRunEncodeOpts,
} from './stream-encode.types';

@Injectable()
export class StreamRunEncodeService {
  private readonly logger = new Logger(StreamRunEncodeService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly ffmpeg: FfmpegService,
    private readonly businessValidation: BusinessValidationService,
  ) {}

  async runEncode(
    slug: string,
    tz: string,
    profile: string,
    append: boolean,
    align: 'wall-clock' | 'episode-start',
    opts: StreamRunEncodeOpts | undefined,
    host: StreamRunEncodeHost,
  ) {
    const mediaRoot = this.config.getOrThrow<string>('MEDIA_ROOT').trim();
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const lookaheadSec = Number(
      this.config.get<string | number>('STREAM_LOOKAHEAD_SEC', 0),
    );
    const hours = host.airTimeHours();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const date = calendarDateInTz(tz);

    const channel = await this.channels.findOne({ slug, isActive: true });
    this.businessValidation.assertExists(channel, 'Channel not found');
    this.businessValidation.assert(channel.isActive, 'Channel is not active');

    const day = await host.loadScheduleDay(channel.id, tz);
    this.businessValidation.assertExists(day, 'No schedule for today');

    const items = day.scheduleItems ?? [];
    const airStart = windowStartAt(date, airWindowStart, tz);
    const inWindow = isWithinAirWindow(airStart, hours);
    const overrun = isFinishingOverrun(items, airStart, hours);
    const finishPending = await readAirFinish(dir);

    // Off air only if there is no overrun finish and no pending finish.
    this.businessValidation.assert(
      inWindow || overrun || !!finishPending,
      'Channel is off air',
    );

    if (finishPending && !inWindow) {
      return host.runFinishEncode(slug, tz, profile, finishPending, append);
    }

    let all = findRemainingPlaylist(items, airStart) ?? [];

    // Continuous seam (finished/skipped): next grid row, NOT wall-clock.
    // Ending-loop delay used to jump Transformers → Flapjack and skip Bakugan.
    let usedSequential = false;
    const completedIds = opts?.completedEpisodeIds ?? [];
    const seamIds =
      completedIds.length > 0
        ? completedIds
        : opts?.skipCurrent && finishPending
          ? [finishPending.episodeId]
          : [];
    if (seamIds.length) {
      const seq = findPlaylistAfterCompleted(
        items,
        seamIds,
        finishPending?.scheduleItemId,
      );
      if (seq?.length) {
        this.logger.log(
          `[${slug}] sequential after ep=${seamIds.join(',')} → next=${seq[0].item.episode?.id ?? seq[0].item.episodeId} (${seq.length} left)`,
        );
        all = seq;
        usedSequential = true;
      } else if (completedIds.length) {
        const done = new Set(completedIds);
        let dropped = 0;
        while (
          all.length &&
          done.has(all[0].item.episode?.id ?? all[0].item.episodeId ?? -1)
        ) {
          all = all.slice(1);
          dropped += 1;
        }
        if (dropped) {
          this.logger.log(
            `[${slug}] advance past ${dropped} completed episode(s) → next`,
          );
        }
        if (all.length) {
          all = all.map((s, i) =>
            i === 0
              ? {
                  item: s.item,
                  inpointSec: 0,
                  durationSec: s.item.durationSec,
                }
              : s,
          );
        } else {
          // Last schedule row done — nothing left on wall-clock either.
          this.businessValidation.assert(false, 'Channel is off air');
        }
      } else if (!seq?.length && seamIds.length && !completedIds.length) {
        // skipCurrent on last row (no completed ids yet)
        this.businessValidation.assert(false, 'Channel is off air');
      }
    }

    if (!usedSequential && opts?.skipCurrent && all.length > 1) {
      this.logger.warn(`[${slug}] stall skip current episode → next`);
      all = all.slice(1).map((s, i) =>
        i === 0
          ? {
              item: s.item,
              inpointSec: 0,
              durationSec: s.item.durationSec,
            }
          : s,
      );
    } else if (!usedSequential && opts?.skipCurrent && all.length <= 1) {
      this.businessValidation.assert(false, 'Channel is off air');
    }

    this.businessValidation.assertNotEmpty(all, 'Channel is off air');

    // Tail < 90s — do not encode the ending (hang + append mash). Go to the next one.
    // Skip on sequential seams: we already chose the next full episode on purpose.
    const tailSkipSec = Number(this.config.get('STREAM_TAIL_SKIP_SEC', 90));
    while (
      !usedSequential &&
      all.length > 1 &&
      all[0].inpointSec > 0 &&
      all[0].durationSec < Math.max(15, tailSkipSec)
    ) {
      this.logger.log(
        `[${slug}] short tail ${all[0].durationSec}s — skip to next episode`,
      );
      all = all.slice(1).map((s, i) =>
        i === 0
          ? {
              item: s.item,
              inpointSec: 0,
              durationSec: s.item.durationSec,
            }
          : s,
      );
    }

    this.businessValidation.assertNotEmpty(all, 'Channel is off air');

    all = trimPlaylistToAirEnd(all, hours, airStart);
    this.businessValidation.assertNotEmpty(all, 'Channel is off air');

    const finishing =
      opts?.onlyCurrent || opts?.persistFinish || (overrun && !inWindow);
    if (finishing) {
      all = [all[0]];
    }

    // episode-start only when explicitly requested (currently nowhere on continue/reconnect).
    if (align === 'episode-start' && all[0].inpointSec > 0) {
      const cur = all[0];
      all = [
        {
          item: cur.item,
          inpointSec: 0,
          durationSec: cur.item.durationSec,
        },
        ...all.slice(1),
      ];
    }

    const useLookahead =
      Number.isFinite(lookaheadSec) && lookaheadSec > 0;
    // Mid-episode: current file only (fast -ss).
    const midEpisode = all[0].inpointSec > 5;
    const segments = midEpisode
      ? [all[0]]
      : useLookahead
        ? capLookahead(all, lookaheadSec)
        : all;

    // Keep append at episode seams — otherwise clear .ts → black screen/pause.
    // Ending mash is fixed via completedEpisodeIds, not by wiping the folder.
    const doAppend = append;

    let hlsSegments: HlsSegmentInput[] = segments.map((seg) => {
      const ep = seg.item.episode;
      this.businessValidation.assertExists(ep, 'Episode file missing');
      return {
        path: join(mediaRoot, ...ep.relativePath.split('/')),
        inpointSec: seg.inpointSec,
        durationSec: seg.durationSec,
      };
    });

    const firstEpForClamp = segments[0].item.episode!;
    const clamped = await clampSegmentsToFile(
      this.logger,
      hlsSegments,
      firstEpForClamp.id,
    );
    if (clamped.skipEpisodeId) {
      this.logger.warn(
        `[${slug}] seek past file end (${clamped.path}) — skip to next slot`,
      );
      return this.runEncode(
        slug,
        tz,
        profile,
        false,
        'wall-clock',
        {
          skipCurrent: true,
          completedEpisodeIds: [clamped.skipEpisodeId],
        },
        host,
      );
    }
    hlsSegments = clamped.segments;
    segments[0].inpointSec = hlsSegments[0].inpointSec;
    segments[0].durationSec = hlsSegments[0].durationSec;

    const first = segments[0];
    const firstEp = first.item.episode;
    const firstPath = hlsSegments[0].path;
    const encodedEpisodeIds = segments
      .map((s) => s.item.episode?.id)
      .filter((id): id is number => typeof id === 'number');
    const remainingAtStart = first.durationSec;
    const encodeStartedAt = Date.now();

    // Air cursor: always write — continuous debt until this cartoon ends.
    const prevCursor = await readAirFinish(dir);
    await writeAirFinish(dir, {
      date,
      episodeId: firstEp.id,
      scheduleItemId: first.item.id,
      mediaPath: firstPath,
      relativePath: firstEp.relativePath,
      inpointSec: first.inpointSec,
      durationSec: first.durationSec,
      source: first.item.source ?? 'regular',
      policy: 'continuous',
      generation: prevCursor?.generation ?? 1,
      savedAt: new Date().toISOString(),
    });

    const key = `${slug}:${tz}:${profile}`;
    const job = await this.ffmpeg.startHls({
      key,
      streamRoot,
      folderName,
      segments: hlsSegments,
      append: doAppend,
      rollingHandoff: useLookahead && !midEpisode,
      onNaturalEnd: ({ rolling }) => {
        if (rolling) {
          // Crash / early handoff — resume same cartoon, do not wall-clock skip.
          void host.continueEncode(slug, tz, profile, { resumeCursor: true });
          return;
        }
        void host.continueEncode(slug, tz, profile, {
          completedEpisodeIds: encodedEpisodeIds,
        });
      },
      onStallEnd: () => {
        const elapsed = (Date.now() - encodeStartedAt) / 1000;
        // Solo/fastSeek: stall after seek ≈ EOF/credits (file shorter than the grid).
        const solo = hlsSegments.length === 1;
        // Episode ending (<~90s left): seam timer often fires at 12–40s.
        // Old "elapsed < 45 → retry" re-encoded the credits in a loop (Prime→Prime→…).
        const shortTail = remainingAtStart <= 90;
        const left = Math.max(0, remainingAtStart - elapsed);
        const nearEof = left <= 90 || (solo && elapsed >= 12);
        // Startup seek only — not EOF hang on last/credits (that replayed the ending).
        if (elapsed < 45 && !shortTail && !nearEof) {
          this.logger.warn(
            `[${slug}] stall during startup/seek (${Math.round(elapsed)}s) — retry same`,
          );
          void host.continueEncode(slug, tz, profile, { resumeCursor: true });
          return;
        }
        const nearEnd =
          shortTail ||
          nearEof ||
          solo ||
          elapsed >= Math.max(0, remainingAtStart - 60);
        if ((shortTail || nearEof) && elapsed < 45) {
          this.logger.warn(
            `[${slug}] short-tail/EOF stall (${Math.round(elapsed)}s / ${Math.round(left)}s left) — advance`,
          );
        }
        void host.continueEncode(slug, tz, profile, {
          skipCurrent: nearEnd,
          completedEpisodeIds:
            nearEnd && firstEp?.id ? [firstEp.id] : undefined,
        });
      },
    });

    job.episodeId = firstEp.id;
    job.scheduleItemId = first.item.id;
    job.offsetSec = first.inpointSec;
    job.source = first.item.source;
    job.remainingCount = all.length;
    job.mediaPath = firstPath;
    job.relativePath = firstEp.relativePath;
    job.durationSec = first.durationSec;

    return {
      channel: slug,
      streamUrl: job.ready ? job.playlistUrl : null,
      episodeId: firstEp.id,
      offsetSec: first.inpointSec,
      source: first.item.source,
      remainingCount: all.length,
      encodeWindowSec: segments.reduce((s, x) => s + x.durationSec, 0),
      airWindowStart,
      ready: !!job.ready,
      playable: !!job.ready,
      status: job.ready ? ('live' as const) : ('starting' as const),
      pollAfterMs: job.ready ? undefined : 2000,
      message: job.ready
        ? undefined
        : 'Эфир есть, подготавливаем поток — подождите несколько секунд',
    };
  }
}
