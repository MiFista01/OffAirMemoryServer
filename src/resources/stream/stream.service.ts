import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { AIR_TIME_HOURS, AIR_WINDOW_START, STREAM_URL_PREFIX } from '@constants';
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
  parseStreamKey,
  streamFolderName,
  trimPlaylistToAirEnd,
  windowStartAt,
} from './stream-air.util';
import { access } from 'fs/promises';
import { join } from 'path';
import { AirHistoryService } from '../air-history/air-history.service';
import { getVideoDurationSec } from '../channels/scan/video-duration';

type HlsSegmentInput = {
  path: string;
  inpointSec: number;
  durationSec: number;
};

/**
 * End-of-air priority:
 * 1) Integrity of the current/last cartoon — play it through to the end.
 * 2) Only when the cartoon truly finished → off air + wipe HLS.
 * air-finish.json survives Nest restart while the frontend drains the tail.
 */
@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
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
  ) {}

  async start(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    return this.withChannelLock(key, () => this.startUnlocked(slug, tz, profile));
  }

  private async withChannelLock<T>(
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

  private async startUnlocked(
    slug: string,
    tz: string,
    profile: string,
  ) {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);

    // 1) Live encode — reconnect, BUT do not serve one stuck on the ending.
    const existing = this.ffmpeg.get(key);
    if (existing && this.ffmpeg.isJobAlive(existing)) {
      const stallSec = Number(this.config.get('STREAM_STALL_SEC', 15));
      const ageMs = await this.ffmpeg.segmentAgeMs(existing.dir);
      const stalled =
        ageMs != null && ageMs >= Math.max(8, stallSec) * 1000;

      if (stalled) {
        const nearEnd = this.isJobNearEpisodeEnd(existing);
        // Mid-episode we do not jump ahead — only restart from wall-clock/cursor.
        // Near the ending — skip, otherwise we hang on EOF again.
        this.logger.warn(
          `[${key}] /start on stalled encode (age=${Math.round((ageMs ?? 0) / 1000)}s` +
            `${nearEnd ? ', near end → skip' : ', mid → restart'})`,
        );
        this.ffmpeg.stop(key);
        // Append only if HLS is still hot; otherwise fresh (no wall-clock jump).
        const append = await this.ffmpeg.isPlaylistFresh(dir);
        if (nearEnd) {
          return this.runEncode(slug, tz, profile, append, 'wall-clock', {
            skipCurrent: true,
            completedEpisodeIds: existing.episodeId
              ? [existing.episodeId]
              : undefined,
          });
        }
        // Mid-stall: resume same cartoon from job cursor, not wall-clock.
        if (
          existing.mediaPath &&
          existing.episodeId &&
          existing.durationSec
        ) {
          const elapsed = Math.max(
            0,
            (Date.now() - (existing.startedAt ?? Date.now())) / 1000,
          );
          const finish = {
            date: calendarDateInTz(tz),
            episodeId: existing.episodeId,
            scheduleItemId: existing.scheduleItemId,
            mediaPath: existing.mediaPath,
            relativePath: existing.relativePath ?? '',
            inpointSec: Math.floor((existing.offsetSec ?? 0) + elapsed),
            durationSec: Math.max(
              1,
              Math.floor(existing.durationSec - elapsed),
            ),
            source: existing.source ?? 'regular',
            policy: 'continuous' as const,
            generation: 1,
            savedAt: new Date().toISOString(),
          };
          await writeAirFinish(dir, finish);
          return this.runFinishEncode(slug, tz, profile, finish, append);
        }
        return this.runEncode(slug, tz, profile, append, 'wall-clock');
      }

      existing.lastAccessAt = Date.now();
      this.ffmpeg.touch(key);
      return this.jobResponse(slug, existing);
    }

    const date = calendarDateInTz(tz);

    // 2) Resume the cartoon we were encoding (idle kill / Nest restart / cold HLS).
    // Never fall back to wall-clock while the cursor is still valid — that jumps
    // W.I.T.C.H. ending → Dragon Hunters just because the schedule moved on.
    const finish = await readAirFinish(dir);
    if (finish) {
      if (finish.date && finish.date !== date) {
        this.logger.log(`[${key}] stale air-finish date=${finish.date} → drop`);
        await clearAirFinish(dir);
      } else {
        // Long absence: continuous debt would replay hours behind the grid.
        // Cap idle since cursor save — then catch up to wall-clock.
        const maxIdleSec = Number(
          this.config.get('STREAM_CURSOR_MAX_IDLE_SEC', 45 * 60),
        );
        const maxIdle =
          Number.isFinite(maxIdleSec) && maxIdleSec > 0
            ? maxIdleSec
            : 45 * 60;
        const savedMs = Date.parse(finish.savedAt);
        const cursorIdle = Number.isFinite(savedMs)
          ? Math.max(0, (Date.now() - savedMs) / 1000)
          : Number.POSITIVE_INFINITY;
        const debtCap = Math.max(finish.durationSec + 120, maxIdle);
        if (cursorIdle > debtCap) {
          this.logger.log(
            `[${key}] air cursor idle ${Math.round(cursorIdle)}s > ${Math.round(debtCap)}s — wall-clock catch-up`,
          );
          await clearAirFinish(dir);
        } else {
          const cold = !(await this.ffmpeg.isPlaylistFresh(dir));
          this.logger.log(
            `[${key}] resume encode cursor episode=${finish.episodeId} +${finish.inpointSec}s` +
              ` remain=${finish.durationSec}s policy=${finish.policy ?? 'continuous'}` +
              `${cold ? ' (cold HLS)' : ''}`,
          );
          // Cold HLS: never append — wiped folder + append_list = zombie SN 404s.
          return this.runFinishEncode(slug, tz, profile, finish, false);
        }
      }
    }

    // Cold start / return to channel: append only to hot HLS.
    // Otherwise stale live-edge + mid-seek = jump into the future and back.
    const append = await this.ffmpeg.isPlaylistFresh(dir);
    return this.runEncode(slug, tz, profile, append, 'wall-clock');
  }

  stop(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    const stopped = this.ffmpeg.stop(key);
    return { channel: slug, key, stopped };
  }

  /** Viewer heartbeat (HLS / nginx auth_request) — keeps idle TTL from killing encode. */
  heartbeat(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    const job = this.ffmpeg.get(key);
    if (job) {
      this.ffmpeg.touch(key);
      return { ok: true, key };
    }
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folder = streamFolderName(slug, tz, profile);
    const touched = this.ffmpeg.touchByFolder(folder);
    return { ok: touched, key, dir: join(streamRoot, folder) };
  }

  /** Before killing ffmpeg on Nest restart — persist the current cartoon playhead. */
  async onModuleDestroy() {
    await Promise.all(
      this.ffmpeg.listJobs().map(async (job) => {
        try {
          await this.ffmpeg.persistJobCursor(job, true);
        } catch (e) {
          this.logger.warn(`onModuleDestroy finish save: ${e}`);
        }
      }),
    );
  }

  /** Final end of air: stop + wipe HLS + clear air-finish. */
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

  /**
   * After an encode chunk ends:
   * - episode file truly finished → do not pick it again via wall-clock (completedEpisodeIds);
   * - still in window → next episodes;
   * - past window + overrun → finish only the current one;
   * - stall past window → wipe.
   */
  private async continueEncode(
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
        const lastOrCredits =
          !nextAfter?.length || finish.durationSec <= 120;
        if (crashes > 3 || (crashes > 1 && lastOrCredits)) {
          this.logger.warn(
            `[${key}] crash resume x${crashes}` +
              `${lastOrCredits ? ' (last/credits)' : ''} — advance past ${finish.episodeId}`,
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

  /**
   * Grid duration can exceed real file length (bad scan / bad inpoint).
   * Clamp ffmpeg window so solo -ss/-t does not EOF instantly (CN Johnny Bravo etc.).
   */
  private async clampSegmentsToFile(
    segments: HlsSegmentInput[],
    episodeId?: number,
  ): Promise<{
    segments: HlsSegmentInput[];
    skipEpisodeId?: number;
    path?: string;
  }> {
    if (!segments.length) return { segments };
    const head = segments[0];
    const fileDur = await getVideoDurationSec(head.path);
    if (fileDur == null || fileDur <= 0) return { segments };

    const inpoint = Math.min(
      Math.max(0, head.inpointSec),
      Math.max(0, fileDur - 0.5),
    );
    const available = fileDur - inpoint;
    if (available <= 0.75) {
      return {
        segments,
        skipEpisodeId: episodeId,
        path: head.path,
      };
    }

    const duration = Math.min(
      head.durationSec,
      Math.max(1, available - 0.5),
    );
    if (
      Math.abs(duration - head.durationSec) > 1.5 ||
      Math.abs(inpoint - head.inpointSec) > 0.5
    ) {
      this.logger.warn(
        `[stream] clamp ${head.path}: in ${head.inpointSec}s→${inpoint}s, ` +
          `dur ${head.durationSec}s→${duration}s (file ${fileDur.toFixed(1)}s)`,
      );
    }

    const out = [...segments];
    out[0] = { ...head, inpointSec: inpoint, durationSec: duration };
    return { segments: out };
  }

  private airTimeHours(): number {
    const hours = Number(
      this.config.get<string | number>('AIR_TIME_HOURS', AIR_TIME_HOURS),
    );
    return Number.isFinite(hours) ? hours : AIR_TIME_HOURS;
  }

  /** Encode is already near the slot ending (job durationSec = remaining at start). */
  private isJobNearEpisodeEnd(job: {
    startedAt?: number;
    offsetSec?: number;
    durationSec?: number;
  }): boolean {
    const remainingAtStart = job.durationSec ?? 0;
    if (remainingAtStart <= 0) return false;
    const started = job.startedAt ?? Date.now();
    const elapsed = (Date.now() - started) / 1000;
    // Previously we wrongly compared inpoint+elapsed to remaining → always "near end".
    return elapsed >= Math.max(0, remainingAtStart - 60);
  }

  /**
   * Day grid: prefer channel calendar (tz), else UTC (same as schedule builder).
   * Otherwise at 02:00 Tallinn we pick yesterday's UTC day and seek/timeouts drift.
   */
  private async loadScheduleDay(channelId: number, tz: string) {
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

  /**
   * The timer does not outrank cartoon integrity:
   * leave a live encode and air-finish.json alone.
   */
  @Interval(60_000)
  async enforceAirWindow() {
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const hours = this.airTimeHours();
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();

    for (const job of this.ffmpeg.listJobs()) {
      try {
        const { slug, tz, profile } = parseStreamKey(job.key);
        const date = calendarDateInTz(tz);
        const airStart = windowStartAt(date, airWindowStart, tz);
        if (isWithinAirWindow(airStart, hours)) continue;

        const dir = join(streamRoot, streamFolderName(slug, tz, profile));

        if (this.ffmpeg.isJobAlive(job)) {
          await this.ensureFinishFromJob(job, dir, date);
          this.logger.log(
            `[${job.key}] past limit — priority: finish current cartoon`,
          );
          continue;
        }

        const finish = await readAirFinish(dir);
        if (finish) {
          this.logger.log(
            `[${job.key}] past limit — air-finish pending, wait for /start`,
          );
          continue;
        }

        await this.shutdownChannelStream(slug, tz, profile);
      } catch (e) {
        this.logger.warn(`enforceAirWindow: ${e}`);
      }
    }
  }

  private async ensureFinishFromJob(
    job: {
      episodeId?: number;
      scheduleItemId?: number;
      offsetSec?: number;
      source?: string;
      mediaPath?: string;
      relativePath?: string;
      durationSec?: number;
      startedAt?: number;
    },
    dir: string,
    date?: string,
  ): Promise<void> {
    if (await readAirFinish(dir)) return;
    if (!job.mediaPath || !job.episodeId || !job.durationSec) return;
    const elapsed = Math.max(
      0,
      (Date.now() - (job.startedAt ?? Date.now())) / 1000,
    );
    await writeAirFinish(dir, {
      date: date ?? calendarDateInTz('Europe/Tallinn'),
      episodeId: job.episodeId,
      scheduleItemId: job.scheduleItemId,
      mediaPath: job.mediaPath,
      relativePath: job.relativePath ?? '',
      inpointSec: Math.floor((job.offsetSec ?? 0) + elapsed),
      durationSec: Math.max(1, Math.floor(job.durationSec - elapsed)),
      source: job.source ?? 'regular',
      policy: 'continuous',
      generation: 1,
      savedAt: new Date().toISOString(),
    });
  }

  /** Resume after restart: this file only, through to the end. */
  private async runFinishEncode(
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
    const finishClamp = await this.clampSegmentsToFile(
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

    return this.jobResponse(slug, job);
  }

  private async runEncode(
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
    const mediaRoot = this.config.getOrThrow<string>('MEDIA_ROOT').trim();
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const lookaheadSec = Number(
      this.config.get<string | number>('STREAM_LOOKAHEAD_SEC', 0),
    );
    const hours = this.airTimeHours();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const date = calendarDateInTz(tz);

    const channel = await this.channels.findOne({ slug, isActive: true });
    this.businessValidation.assertExists(channel, 'Channel not found');
    this.businessValidation.assert(channel.isActive, 'Channel is not active');

    const day = await this.loadScheduleDay(channel.id, tz);
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
      return this.runFinishEncode(slug, tz, profile, finishPending, append);
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
    let droppedTail = false;
    while (
      !usedSequential &&
      all.length > 1 &&
      all[0].inpointSec > 0 &&
      all[0].durationSec < Math.max(15, tailSkipSec)
    ) {
      this.logger.log(
        `[${slug}] short tail ${all[0].durationSec}s — skip to next episode`,
      );
      droppedTail = true;
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
        ? this.capLookahead(all, lookaheadSec)
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
    const clamped = await this.clampSegmentsToFile(
      hlsSegments,
      firstEpForClamp.id,
    );
    if (clamped.skipEpisodeId) {
      this.logger.warn(
        `[${slug}] seek past file end (${clamped.path}) — skip to next slot`,
      );
      return this.runEncode(slug, tz, profile, false, 'wall-clock', {
        skipCurrent: true,
        completedEpisodeIds: [clamped.skipEpisodeId],
      });
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
          void this.continueEncode(slug, tz, profile, { resumeCursor: true });
          return;
        }
        void this.continueEncode(slug, tz, profile, {
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
          void this.continueEncode(slug, tz, profile, { resumeCursor: true });
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
        void this.continueEncode(slug, tz, profile, {
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

  /**
   * Whether HLS is ready. Light polling (~2s).
   * ensure=true — if on air but encode is not running yet (typical after Nest restart /
   * channel switch), start via /start and return starting|live.
   * status: live | starting | idle | off
   */
  async status(
    slug: string,
    tz = 'Europe/Tallinn',
    profile = '720p',
    ensure = false,
  ) {
    const key = `${slug}:${tz}:${profile}`;
    const job = this.ffmpeg.get(key);
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const streamUrl =
      job?.playlistUrl ?? `${STREAM_URL_PREFIX}/${folderName}/playlist.m3u8`;

    let hasPlaylist = false;
    try {
      await access(join(dir, 'playlist.m3u8'));
      hasPlaylist = true;
    } catch {
      hasPlaylist = false;
    }
    const ageMs = hasPlaylist ? await this.ffmpeg.segmentAgeMs(dir) : null;
    const alive = !!(job && this.ffmpeg.isJobAlive(job));
    // Keep idle TTL alive while the client polls /status during cold seek.
    if (alive) this.ffmpeg.touch(key);
    // Never report live from orphan playlist alone — wiped encode leaves fresh .ts briefly.
    let ready =
      !!job?.ready || (alive && ageMs != null && ageMs < 30_000);

    if (job && ready && !job.ready) job.ready = true;

    if (ready && alive) {
      return {
        channel: slug,
        key,
        alive,
        ready: true,
        playable: true,
        status: 'live' as const,
        streamUrl,
        ageSec: ageMs != null ? Math.round(ageMs / 1000) : null,
        pollAfterMs: undefined as number | undefined,
        message: undefined as string | undefined,
      };
    }

    if (alive) {
      return {
        channel: slug,
        key,
        alive: true,
        ready: false,
        playable: false,
        status: 'starting' as const,
        // Do not feed the URL to hls.js yet — would cause a 404 storm.
        streamUrl: null as string | null,
        ageSec: ageMs != null ? Math.round(ageMs / 1000) : null,
        pollAfterMs: 2000,
        message: 'Эфир есть, подготавливаем поток — подождите',
      };
    }

    // No job: either not started yet (after restart / channel switch), or off air.
    const onAir = await this.isChannelOnAir(slug, tz, profile);
    if (!onAir) {
      return {
        channel: slug,
        key,
        alive: false,
        ready: false,
        playable: false,
        status: 'off' as const,
        streamUrl: null as string | null,
        ageSec: null as number | null,
        pollAfterMs: undefined as number | undefined,
        message: 'Сейчас не в эфире',
      };
    }

    if (ensure) {
      try {
        const started = await this.start(slug, tz, profile);
        const startedReady = !!started.ready;
        return {
          channel: slug,
          key,
          alive: true,
          ready: startedReady,
          playable: startedReady,
          status: startedReady ? ('live' as const) : ('starting' as const),
          streamUrl: startedReady ? started.streamUrl : null,
          ageSec: null as number | null,
          pollAfterMs: startedReady ? undefined : 2000,
          message: started.message,
        };
      } catch (e) {
        this.logger.warn(`[${key}] status ensure start failed: ${e}`);
        return {
          channel: slug,
          key,
          alive: false,
          ready: false,
          playable: false,
          status: 'off' as const,
          streamUrl: null as string | null,
          ageSec: null as number | null,
          pollAfterMs: undefined as number | undefined,
          message: 'Сейчас не в эфире',
        };
      }
    }

    return {
      channel: slug,
      key,
      alive: false,
      ready: false,
      playable: false,
      status: 'idle' as const,
      streamUrl: null as string | null,
      ageSec: null as number | null,
      pollAfterMs: 2000,
      message:
        'Эфир есть, поток ещё не запущен — подождите или вызовите /start',
    };
  }

  /** In the air window / overrun / air-finish — encode may be started. */
  private async isChannelOnAir(
    slug: string,
    tz: string,
    profile: string,
  ): Promise<boolean> {
    const channel = await this.channels.findOne({ slug, isActive: true });
    if (!channel?.isActive) return false;

    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const hours = this.airTimeHours();
    const date = calendarDateInTz(tz);
    const airStart = windowStartAt(date, airWindowStart, tz);
    if (isWithinAirWindow(airStart, hours)) return true;

    const day = await this.loadScheduleDay(channel.id, tz);
    if (day && isFinishingOverrun(day.scheduleItems, airStart, hours)) {
      return true;
    }

    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const finish = await readAirFinish(
      join(streamRoot, streamFolderName(slug, tz, profile)),
    );
    return !!finish;
  }

  private jobResponse(
    slug: string,
    job: {
      playlistUrl: string;
      episodeId?: number;
      offsetSec?: number;
      source?: string;
      remainingCount?: number;
      ready?: boolean;
    },
  ) {
    const ready = !!job.ready;
    return {
      channel: slug,
      streamUrl: ready ? job.playlistUrl : null,
      episodeId: job.episodeId ?? 0,
      offsetSec: job.offsetSec ?? 0,
      source: job.source ?? 'regular',
      remainingCount: job.remainingCount ?? 0,
      encodeWindowSec: 0,
      airWindowStart: this.config.get<string>(
        'AIR_WINDOW_START',
        AIR_WINDOW_START,
      ),
      ready,
      playable: ready,
      status: ready ? ('live' as const) : ('starting' as const),
      pollAfterMs: ready ? undefined : 2000,
      message: ready
        ? undefined
        : 'Эфир есть, подготавливаем поток — подождите несколько секунд',
    };
  }

  private capLookahead<T extends { durationSec: number }>(
    segments: T[],
    maxSec: number,
  ): T[] {
    const out: T[] = [];
    let acc = 0;
    for (const seg of segments) {
      out.push(seg);
      acc += seg.durationSec;
      if (acc >= maxSec) break;
    }
    return out;
  }
}
