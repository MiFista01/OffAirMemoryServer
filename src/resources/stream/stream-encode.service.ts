import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIR_TIME_HOURS, AIR_WINDOW_START } from '@constants';
import { ChannelsService } from '../channels/channels/channels.service';
import { ScheduleDayService } from '../schedule-day/schedule-day/schedule-day.service';
import { todayUtcDate } from '../schedule-day/schedule-day/schedule-day.builder';
import { FfmpegService } from './ffmpeg.service';
import { BusinessValidationService } from '@utils';
import {
  clearAirFinish,
  readAirFinish,
  writeAirFinish,
  type AirFinishState,
} from './air-finish.state';
import {
  calendarDateInTz,
  findPlaylistAfterCompleted,
  findRemainingPlaylist,
  isFinishingOverrun,
  isWithinAirWindow,
  streamFolderName,
  windowStartAt,
} from './stream-air.util';
import { join } from 'path';
import { AirHistoryService } from '../air-history/air-history.service';
import {
  clampSegmentsToFile,
  ensureFinishFromJob,
  isJobNearEpisodeEnd,
  jobResponse,
  type HlsSegmentInput,
} from './stream-encode.helpers';
import { StreamRunEncodeService } from './stream-run-encode.service';
import type { StreamRunEncodeHost } from './stream-encode.types';

@Injectable()
export class StreamEncodeService {
  private readonly logger = new Logger(StreamEncodeService.name);
  /** Serialize continueEncode / start per channel key — no overlapping seams. */
  private readonly continueLocks = new Map<string, Promise<void>>();
  /** Crash→resumeCursor loops on a bad file — skip after N. */
  private readonly crashResumeCounts = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly scheduleDays: ScheduleDayService,
    private readonly ffmpeg: FfmpegService,
    private readonly businessValidation: BusinessValidationService,
    private readonly airHistory: AirHistoryService,
    private readonly runner: StreamRunEncodeService,
  ) {}

  /** Callbacks for RunEncode — breaks circular DI without ModuleRef. */
  private runHost(): StreamRunEncodeHost {
    return {
      airTimeHours: () => this.airTimeHours(),
      loadScheduleDay: (channelId, tz) => this.loadScheduleDay(channelId, tz),
      runFinishEncode: (slug, tz, profile, finish, append) =>
        this.runFinishEncode(slug, tz, profile, finish, append),
      continueEncode: (slug, tz, profile, opts) =>
        this.continueEncode(slug, tz, profile, opts),
    };
  }

  async withChannelLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.continueLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chain = prev.then(() => gate);
    this.continueLocks.set(key, chain);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.continueLocks.get(key) === chain) {
        this.continueLocks.delete(key);
      }
    }
  }

  isJobNearEpisodeEnd = isJobNearEpisodeEnd;
  ensureFinishFromJob = ensureFinishFromJob;

  airTimeHours(): number {
    const hours = Number(
      this.config.get<string | number>('AIR_TIME_HOURS', AIR_TIME_HOURS),
    );
    return Number.isFinite(hours) ? hours : AIR_TIME_HOURS;
  }

  async loadScheduleDay(channelId: number, tz: string) {
    const localDate = calendarDateInTz(tz);
    const relations = ['scheduleItems', 'scheduleItems.episode'] as const;
    let day = await this.scheduleDays.findOne(
      { channelId, date: localDate },
      [...relations],
    );
    if (!day) {
      const utcDate = todayUtcDate();
      if (utcDate !== localDate) {
        day = await this.scheduleDays.findOne(
          { channelId, date: utcDate },
          [...relations],
        );
      }
    }
    return day;
  }

  async shutdownChannelStream(
    slug: string,
    tz: string,
    profile: string,
  ): Promise<void> {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    this.logger.log(`[${key}] end of air — stop + clear HLS`);
    const job = this.ffmpeg.get(key);
    if (job) {
      await this.ffmpeg.stopAndClear(key);
    } else {
      this.ffmpeg.stop(key);
      await this.ffmpeg.clearHlsFolder(dir);
    }
    await clearAirFinish(dir);
  }

  /** Seam after encode chunk: next episodes, overrun finish, or wipe. */
  async continueEncode(
    slug: string,
    tz: string,
    profile: string,
    opts?: {
      skipCurrent?: boolean;
      /** Episodes ffmpeg already fully delivered in this window (code=0). */
      completedEpisodeIds?: number[];
      /** Crash / rolling — resume air cursor, do not wall-clock skip. */
      resumeCursor?: boolean;
    },
  ) {
    const key = `${slug}:${tz}:${profile}`;
    return this.withChannelLock(key, () =>
      this.continueEncodeUnlocked(slug, tz, profile, opts),
    );
  }

  private async continueEncodeUnlocked(
    slug: string,
    tz: string,
    profile: string,
    opts?: {
      skipCurrent?: boolean;
      completedEpisodeIds?: number[];
      resumeCursor?: boolean;
    },
  ) {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const dir = join(streamRoot, streamFolderName(slug, tz, profile));

    try {
      const airWindowStart = this.config.get<string>(
        'AIR_WINDOW_START',
        AIR_WINDOW_START,
      );
      const hours = this.airTimeHours();
      const date = calendarDateInTz(tz);
      const airStart = windowStartAt(date, airWindowStart, tz);
      const inWindow = isWithinAirWindow(airStart, hours);
      const finish = await readAirFinish(dir);

      if (opts?.resumeCursor && finish) {
        // Credits / short leftover — never re-encode the ending (loops JL credits → restart).
        if (finish.durationSec <= 120) {
          this.logger.warn(
            `[${key}] resume cursor on short tail ${finish.durationSec}s — advance past ${finish.episodeId}`,
          );
          this.crashResumeCounts.delete(key);
          await clearAirFinish(dir);
          if (inWindow) {
            await this.runEncode(slug, tz, profile, false, 'wall-clock', {
              skipCurrent: true,
              completedEpisodeIds: [finish.episodeId],
            });
            return;
          }
          await this.shutdownChannelStream(slug, tz, profile);
          return;
        }
        const crashes = (this.crashResumeCounts.get(key) ?? 0) + 1;
        this.crashResumeCounts.set(key, crashes);
        // Credits / last-row hang: don't re-encode the ending forever.
        const channelEarly = await this.channels.findOne({
          slug,
          isActive: true,
        });
        const dayEarly = channelEarly
          ? await this.loadScheduleDay(channelEarly.id, tz)
          : null;
        const nextAfter = dayEarly
          ? findPlaylistAfterCompleted(
              dayEarly.scheduleItems,
              [finish.episodeId],
              finish.scheduleItemId,
            )
          : null;
        const lastOrCredits = !nextAfter?.length;
        if (crashes > 3 || (crashes > 1 && lastOrCredits)) {
          this.logger.warn(
            `[${key}] crash resume x${crashes}` +
              `${lastOrCredits ? ' (last row)' : ''} — advance past ${finish.episodeId}`,
          );
          this.crashResumeCounts.delete(key);
          await clearAirFinish(dir);
          if (inWindow && nextAfter?.length) {
            await this.runEncode(slug, tz, profile, false, 'wall-clock', {
              skipCurrent: true,
              completedEpisodeIds: [finish.episodeId],
            });
            return;
          }
          // No next row (or past window) → off air
          await this.shutdownChannelStream(slug, tz, profile);
          return;
        }
        this.logger.log(
          `[${key}] resume cursor after crash/handoff episode=${finish.episodeId} (try ${crashes})`,
        );
        await this.runFinishEncode(slug, tz, profile, finish, false);
        return;
      }

      // Successful seam (not crash-loop) — reset breaker.
      if (opts?.completedEpisodeIds?.length || opts?.skipCurrent) {
        this.crashResumeCounts.delete(key);
      }

      const channel = await this.channels.findOne({ slug, isActive: true });
      const day = channel
        ? await this.loadScheduleDay(channel.id, tz)
        : null;
      const overrun = day
        ? isFinishingOverrun(day.scheduleItems, airStart, hours)
        : false;

      // History for tomorrow's grid: fully played episodes.
      if (channel && opts?.completedEpisodeIds?.length) {
        void this.airHistory
          .recordFinishedMany(
            channel.id,
            date,
            opts.completedEpisodeIds,
            'stream',
          )
          .catch((e) =>
            this.logger.warn(`[${key}] air-history record failed: ${e}`),
          );
      }

      if (inWindow) {
        // Last schedule row finished/skipped — go off air now (do not re-encode credits).
        const seamDone =
          opts?.completedEpisodeIds?.length || opts?.skipCurrent
            ? (opts.completedEpisodeIds?.length
                ? opts.completedEpisodeIds
                : finish
                  ? [finish.episodeId]
                  : [])
            : [];
        if (seamDone.length && day) {
          const next = findPlaylistAfterCompleted(
            day.scheduleItems,
            seamDone,
            finish?.scheduleItemId,
          );
          if (!next?.length) {
            this.logger.log(
              `[${key}] end of schedule after ep=${seamDone.join(',')} → off air`,
            );
            await this.shutdownChannelStream(slug, tz, profile);
            return;
          }
        }

        // Append only while HLS is hot+complete — otherwise zombie m3u8 (404 storm).
        const append =
          !!opts?.skipCurrent ||
          !!opts?.completedEpisodeIds?.length ||
          ((await this.ffmpeg.isPlaylistFresh(dir)) &&
            (await this.ffmpeg.isPlaylistAppendable(dir)));
        await this.runEncode(slug, tz, profile, append, 'wall-clock', {
          skipCurrent: !!opts?.skipCurrent,
          completedEpisodeIds: opts?.completedEpisodeIds,
        });
        return;
      }

      if (opts?.skipCurrent) {
        this.logger.warn(`[${key}] stall during finish → off air`);
        await this.shutdownChannelStream(slug, tz, profile);
        return;
      }

      // File finished but the grid still "holds" the slot → do not replay the ending.
      if (opts?.completedEpisodeIds?.length) {
        if (overrun) {
          const rem = day
            ? findRemainingPlaylist(day.scheduleItems, airStart)
            : null;
          const curId = rem?.[0]?.item.episode?.id;
          if (curId && opts.completedEpisodeIds.includes(curId)) {
            this.logger.log(
              `[${key}] finished overrun episode ${curId} → off air`,
            );
            await this.shutdownChannelStream(slug, tz, profile);
            return;
          }
        } else if (finish && opts.completedEpisodeIds.includes(finish.episodeId)) {
          this.logger.log(`[${key}] last cartoon completed → off air`);
          await this.shutdownChannelStream(slug, tz, profile);
          return;
        }
      }

      if (overrun) {
        this.logger.log(`[${key}] past limit — continue finishing cartoon`);
        await this.runEncode(slug, tz, profile, true, 'wall-clock', {
          onlyCurrent: true,
          persistFinish: true,
          completedEpisodeIds: opts?.completedEpisodeIds,
        });
        return;
      }

      if (finish) {
        this.logger.log(`[${key}] last cartoon completed → off air`);
        await this.shutdownChannelStream(slug, tz, profile);
        return;
      }

      await this.shutdownChannelStream(slug, tz, profile);
    } catch (e) {
      this.logger.warn(
        `[${slug}] continue ended (${e instanceof Error ? e.message : e}) — clear HLS`,
      );
      await this.shutdownChannelStream(slug, tz, profile);
    }
  }

  /** Resume after restart: this file only, through to the end. */
  async runFinishEncode(
    slug: string,
    tz: string,
    profile: string,
    finish: AirFinishState,
    append: boolean,
  ) {
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const key = `${slug}:${tz}:${profile}`;
    const date = calendarDateInTz(tz);

    let inpoint = finish.inpointSec;
    let duration = finish.durationSec;

    // While Nest was down / idle the frontend may have drained the buffer — advance inpoint.
    const savedMs = Date.parse(finish.savedAt);
    if (Number.isFinite(savedMs)) {
      const idleSec = Math.max(0, Math.floor((Date.now() - savedMs) / 1000));
      if (idleSec > 0 && idleSec < duration) {
        inpoint += idleSec;
        duration -= idleSec;
      } else if (idleSec >= duration) {
        const airWindowStart = this.config.get<string>(
          'AIR_WINDOW_START',
          AIR_WINDOW_START,
        );
        const hours = this.airTimeHours();
        const airStart = windowStartAt(date, airWindowStart, tz);
        if (isWithinAirWindow(airStart, hours)) {
          this.logger.log(
            `[${key}] air-finish elapsed during downtime → next episode (sequential)`,
          );
          await clearAirFinish(dir);
          // Sequential after this episode — not wall-clock (would skip owed slots).
          return this.runEncode(slug, tz, profile, false, 'wall-clock', {
            completedEpisodeIds: [finish.episodeId],
          });
        }
        this.logger.log(
          `[${key}] air-finish already elapsed during downtime → off air`,
        );
        await this.shutdownChannelStream(slug, tz, profile);
        this.businessValidation.assert(false, 'Channel is off air');
      }
    }

    // Tiny leftover only — finish credits if ≥20s; else sequential next.
    if (duration < 20) {
      this.logger.log(
        `[${key}] finish remaining ${duration}s — skip to next (sequential)`,
      );
      await clearAirFinish(dir);
      return this.runEncode(slug, tz, profile, false, 'wall-clock', {
        completedEpisodeIds: [finish.episodeId],
      });
    }

    // Do NOT catch up inpoint to wall-clock: if we were behind schedule, stay behind
    // until this cartoon ends (otherwise idle → jump to the current grid slot).

    const remain = Math.max(1, duration);
    const updated: AirFinishState = {
      ...finish,
      date: finish.date || date,
      inpointSec: inpoint,
      durationSec: remain,
      policy: finish.policy ?? 'continuous',
      generation: finish.generation ?? 1,
    };
    await writeAirFinish(dir, updated);

    let segments: HlsSegmentInput[] = [
      {
        path: finish.mediaPath,
        inpointSec: updated.inpointSec,
        durationSec: updated.durationSec,
      },
    ];
    const finishClamp = await clampSegmentsToFile(this.logger, 
      segments,
      finish.episodeId,
    );
    if (finishClamp.skipEpisodeId) {
      await clearAirFinish(dir);
      return this.runEncode(slug, tz, profile, false, 'wall-clock', {
        completedEpisodeIds: [finish.episodeId],
      });
    }
    segments = finishClamp.segments;
    updated.inpointSec = segments[0].inpointSec;
    updated.durationSec = segments[0].durationSec;
    await writeAirFinish(dir, updated);

    const encodeStartedAt = Date.now();
    const remainingAtStart = updated.durationSec;

    const job = await this.ffmpeg.startHls({
      key,
      streamRoot,
      folderName,
      segments,
      append,
      rollingHandoff: false,
      onNaturalEnd: ({ rolling }) => {
        if (rolling) {
          void this.continueEncode(slug, tz, profile, { resumeCursor: true });
          return;
        }
        void this.continueEncode(slug, tz, profile, {
          completedEpisodeIds: [finish.episodeId],
        });
      },
      onStallEnd: () => {
        const elapsed = (Date.now() - encodeStartedAt) / 1000;
        // Short finish tails: solo-seam kills ffmpeg before 45s — "retry" loops the ending.
        const shortTail = remainingAtStart <= 90;
        const left = Math.max(0, remainingAtStart - elapsed);
        const nearEof = left <= 90;
        // Near EOF hang — advance/off-air, do not resumeCursor the credits.
        if (elapsed < 45 && !shortTail && !nearEof) {
          this.logger.warn(
            `[${key}] finish stall during seek (${Math.round(elapsed)}s) — retry`,
          );
          void this.continueEncode(slug, tz, profile, { resumeCursor: true });
          return;
        }
        const nearEnd =
          shortTail || nearEof || elapsed >= Math.max(0, remainingAtStart - 60);
        void this.continueEncode(slug, tz, profile, {
          skipCurrent: nearEnd,
          completedEpisodeIds: nearEnd ? [finish.episodeId] : undefined,
        });
      },
    });

    job.episodeId = finish.episodeId;
    job.scheduleItemId = finish.scheduleItemId;
    job.offsetSec = updated.inpointSec;
    job.source = finish.source;
    job.remainingCount = 1;
    job.mediaPath = finish.mediaPath;
    job.relativePath = finish.relativePath;
    job.durationSec = updated.durationSec;

    return jobResponse(this.config, slug, job);
  }

  runEncode(
    slug: string,
    tz: string,
    profile: string,
    append: boolean,
    align: 'wall-clock' | 'episode-start',
    opts?: {
      skipCurrent?: boolean;
      onlyCurrent?: boolean;
      persistFinish?: boolean;
      completedEpisodeIds?: number[];
    },
  ) {
    return this.runner.runEncode(
      slug,
      tz,
      profile,
      append,
      align,
      opts,
      this.runHost(),
    );
  }
}
