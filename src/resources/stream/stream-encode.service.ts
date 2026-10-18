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
import { markAirAhead } from './air-ahead.state';
import {
  calendarDateInTz,
  findPlaylistAfterCompleted,
  findRemainingPlaylist,
  isFinishingOverrun,
  isWithinAirWindow,
  msUntilScheduleItemEnd,
  streamFolderName,
  windowStartAt,
} from './stream-air.util';
import { join } from 'path';
import { AirHistoryService } from '../air-history/air-history.service';
import {
  clampSegmentsToFile,
  ensureFinishFromJob,
  isBridgeEncodeJob,
  isJobNearEpisodeEnd,
  jobResponse,
  type HlsSegmentInput,
} from './stream-encode.helpers';
import { StreamRunEncodeService } from './stream-run-encode.service';
import type { StreamRunEncodeHost } from './stream-encode.types';
import { StreamRealtimeService } from './stream-realtime.service';
import {
  streamJobKey,
  streamSlotFolder,
  type StreamSlot,
} from './stream-slot.util';
import type { FfmpegJob } from '@app-types';

@Injectable()
export class StreamEncodeService {
  private readonly logger = new Logger(StreamEncodeService.name);
  /** Serialize continueEncode / start per channel key — no overlapping seams. */
  private readonly continueLocks = new Map<string, Promise<void>>();
  /** Crash→resumeCursor loops on a bad file — skip after N. */
  private readonly crashResumeCounts = new Map<string, number>();
  /** Air finished early vs guide — resume sequential when wall catches up. */
  private readonly aheadHoldTimers = new Map<string, NodeJS.Timeout>();
  /** Active encode past its grid slot — catch up without waiting for F5. */
  private readonly slotEndTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly scheduleDays: ScheduleDayService,
    private readonly ffmpeg: FfmpegService,
    private readonly businessValidation: BusinessValidationService,
    private readonly airHistory: AirHistoryService,
    private readonly runner: StreamRunEncodeService,
    private readonly realtime: StreamRealtimeService,
  ) {}

  /** Callbacks for RunEncode — breaks circular DI without ModuleRef. */
  private runHost(): StreamRunEncodeHost {
    return {
      airTimeHours: () => this.airTimeHours(),
      loadScheduleDay: (channelId, tz) => this.loadScheduleDay(channelId, tz),
      runFinishEncode: (slug, tz, profile, finish, append, opts) =>
        this.runFinishEncode(slug, tz, profile, finish, append, opts),
      continueEncode: (slug, tz, profile, opts) =>
        this.continueEncode(slug, tz, profile, opts),
      holdForWallCatchUp: (slug, tz, profile, completedIds, waitMs) =>
        this.holdForWallCatchUp(slug, tz, profile, completedIds, waitMs),
      armSlotEndCatchUp: (slug, tz, profile, scheduleItemId, episodeId, waitMs) =>
        this.armSlotEndCatchUp(
          slug,
          tz,
          profile,
          scheduleItemId,
          episodeId,
          waitMs,
        ),
      recordFinishedEpisodes: (channelId, date, episodeIds) =>
        this.airHistory
          .recordFinishedMany(channelId, date, episodeIds, 'stream')
          .catch((e) =>
            this.logger.warn(`[air-history] recordFinishedMany failed: ${e}`),
          ),
      spawnStandby: (slug, tz, profile, opts) =>
        this.spawnStandby(slug, tz, profile, opts),
      promoteStandby: (slug, tz, profile) =>
        this.promoteStandby(slug, tz, profile),
      watchStandbyPromote: (slug, tz, profile) =>
        this.watchStandbyPromote(slug, tz, profile),
      guidePastScheduleItem: (slug, tz, scheduleItemId) =>
        this.guidePastScheduleItem(slug, tz, scheduleItemId),
    };
  }

  private readonly standbyWatchTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Dual-slot: encode the next owed episode into the inactive slot while
   * the active ffmpeg keeps serving the current cartoon.
   */
  async spawnStandby(
    slug: string,
    tz: string,
    profile: string,
    opts: { completedEpisodeIds: number[] },
  ): Promise<void> {
    const key = `${slug}:${tz}:${profile}`;
    if (this.ffmpeg.getStandbySlot(key)) {
      const existing = this.ffmpeg.getBySlot(
        key,
        this.ffmpeg.getStandbySlot(key)!,
      );
      if (existing && this.ffmpeg.isJobAlive(existing)) {
        this.logger.log(`[${key}] standby already warming — skip spawn`);
        void this.watchStandbyPromote(slug, tz, profile);
        return;
      }
    }
    this.logger.log(
      `[${key}] spawn standby after ep=${opts.completedEpisodeIds.join(',')}`,
    );
    try {
      await this.withChannelLock(key, async () => {
        await this.runEncode(slug, tz, profile, false, 'wall-clock', {
          completedEpisodeIds: opts.completedEpisodeIds,
          asStandby: true,
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Control-flow abort (should be rare after standby-ahead fix).
      if (/air-grid-hold/i.test(msg)) {
        this.logger.log(`[${key}] standby spawn held — skip warm`);
        return;
      }
      throw e;
    }
  }

  /** True when wall-clock has moved past this schedule row. */
  async guidePastScheduleItem(
    slug: string,
    tz: string,
    scheduleItemId: number,
  ): Promise<boolean> {
    const channel = await this.channels.findOne({ slug, isActive: true });
    if (!channel) return true;
    const day = await this.loadScheduleDay(channel.id, tz);
    if (!day?.scheduleItems?.length) return true;
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const date = calendarDateInTz(tz);
    const airStart = windowStartAt(date, airWindowStart, tz);
    const wall = findRemainingPlaylist(day.scheduleItems, airStart);
    if (!wall?.length) return true;
    const cursorItem = day.scheduleItems.find((i) => i.id === scheduleItemId);
    if (!cursorItem) return true;
    return wall[0].item.order > cursorItem.order;
  }

  /**
   * Standby -re burns intro while waiting for promote — HLS window starts mid-episode.
   * Cold-restart if burn exceeds cap before flip.
   */
  private async ensureStandbyFreshIntro(
    slug: string,
    tz: string,
    profile: string,
    channelKey: string,
    standbySlot: StreamSlot,
    priorEpisodeId: number | undefined,
    job: FfmpegJob,
  ): Promise<FfmpegJob | undefined> {
    const maxBurn = Number(
      this.config.get('STREAM_STANDBY_MAX_BURN_SEC', 12),
    );
    const burn =
      (job.offsetSec ?? 0) +
      Math.max(0, (Date.now() - (job.startedAt ?? Date.now())) / 1000);
    if (burn <= maxBurn || (job.offsetSec ?? 0) > 2) return job;
    if (!priorEpisodeId) return job;

    this.logger.warn(
      `[${channelKey}] standby intro burn ${Math.round(burn)}s — cold restart before promote`,
    );
    try {
      this.ffmpeg.stop(job.key);
    } catch {
      /* ignore */
    }
    this.ffmpeg.setStandbySlot(channelKey, undefined);
    try {
      await this.withChannelLock(channelKey, async () => {
        await this.runEncode(slug, tz, profile, false, 'wall-clock', {
          completedEpisodeIds: [priorEpisodeId],
          asStandby: true,
        });
      });
    } catch (e) {
      this.logger.warn(
        `[${channelKey}] standby intro restart failed: ${e instanceof Error ? e.message : e}`,
      );
      return undefined;
    }
    const slot = this.ffmpeg.getStandbySlot(channelKey) ?? standbySlot;
    for (let i = 0; i < 28; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const j = this.ffmpeg.getBySlot(channelKey, slot);
      if (j?.ready && this.ffmpeg.isJobAlive(j)) return j;
    }
    return this.ffmpeg.getBySlot(channelKey, slot);
  }

  /** Flip active to standby slot and tell clients to switch playlist URL. */
  async promoteStandby(
    slug: string,
    tz: string,
    profile: string,
  ): Promise<'promoted' | 'deferred' | 'failed'> {
    const key = `${slug}:${tz}:${profile}`;
    let standby = this.ffmpeg.getStandbySlot(key);
    if (!standby) {
      this.logger.warn(`[${key}] promoteStandby — no standby slot`);
      return 'failed';
    }
    let job = this.ffmpeg.getBySlot(key, standby);
    if (!job || !this.ffmpeg.isJobAlive(job) || !job.ready) {
      this.logger.warn(`[${key}] promoteStandby — standby not ready`);
      // One soft retry — cold seek can finish shortly; do not wipe active.
      const prev = this.standbyWatchTimers.get(key);
      if (!prev) {
        const t = setTimeout(() => {
          this.standbyWatchTimers.delete(key);
          void this.promoteStandby(slug, tz, profile);
        }, 5_000);
        this.standbyWatchTimers.set(key, t);
      }
      return 'failed';
    }
    const oldSlot = this.ffmpeg.getActiveSlot(key);
    const retiring = this.ffmpeg.getBySlot(key, oldSlot);
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const channelDir = join(streamRoot, streamFolderName(slug, tz, profile));
    const finish = await readAirFinish(channelDir);
    const priorItemId =
      finish?.scheduleItemId ?? retiring?.scheduleItemId ?? null;
    // Short file / credits EOF while guide still in the slot (Rick post-credits).
    // Do NOT promote early — but KEEP standby warm from episode start.
    // Killing it used to force a later wall-clock /start into Kim ~50s in.
    if (priorItemId != null) {
      const past = await this.guidePastScheduleItem(slug, tz, priorItemId);
      if (!past) {
        const channel = await this.channels.findOne({ slug, isActive: true });
        const day = channel
          ? await this.loadScheduleDay(channel.id, tz)
          : null;
        const airWindowStart = this.config.get<string>(
          'AIR_WINDOW_START',
          AIR_WINDOW_START,
        );
        const airStart = windowStartAt(
          calendarDateInTz(tz),
          airWindowStart,
          tz,
        );
        const waitMs = Math.max(
          1_500,
          msUntilScheduleItemEnd(day?.scheduleItems, priorItemId, airStart) +
            400,
        );
        this.logger.warn(
          `[${key}] promote deferred — guide still in item=${priorItemId} ` +
            `(retry in ~${Math.round(waitMs / 1000)}s, freeze standby)`,
        );
        // Standby -re from 0 during the whole hold burned Tom&Jerry intro (switch @ ~45s).
        const doneEp =
          retiring?.episodeId ?? finish?.episodeId ?? undefined;
        try {
          this.ffmpeg.stop(job.key);
        } catch {
          /* ignore */
        }
        this.ffmpeg.setStandbySlot(key, undefined);
        // Tell client we're between cartoons — keep last frame, no /start wipe.
        this.realtime.emitHint(slug, 'wait', {
          status: 'seam',
          // Empty message → client stays silent if picture/last frame exists.
        });
        const prev = this.standbyWatchTimers.get(key);
        if (prev) clearTimeout(prev);
        const prepLeadMs = Math.min(
          28_000,
          Math.max(15_000, waitMs - 2_000),
        );
        const spawnDelayMs = Math.max(0, waitMs - prepLeadMs);
        if (doneEp && spawnDelayMs >= 0) {
          setTimeout(() => {
            void this.spawnStandby(slug, tz, profile, {
              completedEpisodeIds: [doneEp],
            }).catch((e) =>
              this.logger.warn(`[${key}] deferred standby respawn: ${e}`),
            );
          }, spawnDelayMs);
        }
        const t = setTimeout(() => {
          this.standbyWatchTimers.delete(key);
          void this.promoteStandby(slug, tz, profile);
        }, waitMs);
        this.standbyWatchTimers.set(key, t);
        return 'deferred';
      }
    }

    const priorEp =
      retiring?.episodeId ?? finish?.episodeId ?? undefined;
    const freshJob = await this.ensureStandbyFreshIntro(
      slug,
      tz,
      profile,
      key,
      standby,
      priorEp,
      job,
    );
    if (freshJob) job = freshJob;
    standby = this.ffmpeg.getStandbySlot(key) ?? standby;
    if (!this.ffmpeg.isJobAlive(job) || !job.ready) {
      this.logger.warn(`[${key}] promoteStandby — standby not ready after intro check`);
      return 'failed';
    }

    this.ffmpeg.setActiveSlot(key, standby);
    this.ffmpeg.setStandbySlot(key, undefined);
    this.clearSlotEndCatchUp(key);
    const gen = (finish?.generation ?? 0) + 1;
    // Viewer starts at intro on switch — do not persist standby burn into cursor.
    if (job.episodeId && job.mediaPath && job.durationSec) {
      await writeAirFinish(channelDir, {
        date: calendarDateInTz(tz),
        episodeId: job.episodeId,
        scheduleItemId: job.scheduleItemId,
        mediaPath: job.mediaPath,
        relativePath: job.relativePath ?? '',
        inpointSec: 0,
        durationSec: Math.max(1, Math.floor(job.durationSec)),
        source: job.source ?? 'regular',
        policy: 'continuous',
        generation: gen,
        savedAt: new Date().toISOString(),
      });
      const finishedEp =
        finish?.episodeId && finish.episodeId !== job.episodeId
          ? finish.episodeId
          : retiring?.episodeId && retiring.episodeId !== job.episodeId
            ? retiring.episodeId
            : null;
      const finishedItemId =
        finish?.episodeId === finishedEp
          ? finish?.scheduleItemId
          : retiring?.scheduleItemId;
      if (finishedEp) {
        await markAirAhead(
          channelDir,
          calendarDateInTz(tz),
          [finishedEp],
          finishedItemId != null ? [finishedItemId] : undefined,
        );
        // Dual-slot promote used to skip air-history → same ep next day.
        const channel = await this.channels.findOne({ slug, isActive: true });
        if (channel) {
          void this.airHistory
            .recordFinished({
              channelId: channel.id,
              episodeId: finishedEp,
              date: calendarDateInTz(tz),
              scheduleItemId: finishedItemId ?? null,
              origin: 'stream',
            })
            .catch((e) =>
              this.logger.warn(`[${key}] promote air-history failed: ${e}`),
            );
        }
      }
    }
    this.logger.log(
      `[${key}] slot ${oldSlot}→${standby} switch ep=${job.episodeId} gen=${gen}`,
    );
    if (job.scheduleItemId && job.episodeId) {
      const channel = await this.channels.findOne({ slug, isActive: true });
      if (channel) {
        const day = await this.loadScheduleDay(channel.id, tz);
        const airWindowStart = this.config.get<string>(
          'AIR_WINDOW_START',
          AIR_WINDOW_START,
        );
        const airStart = windowStartAt(
          calendarDateInTz(tz),
          airWindowStart,
          tz,
        );
        const left = msUntilScheduleItemEnd(
          day?.scheduleItems,
          job.scheduleItemId,
          airStart,
        );
        this.armSlotEndCatchUp(
          slug,
          tz,
          profile,
          job.scheduleItemId,
          job.episodeId,
          left + 750,
        );
      }
    }
    this.realtime.emitHint(slug, 'switch', {
      // live + ready: client switches slots silently (no "эфир" chyron).
      status: 'live',
      streamUrl: job.playlistUrl,
      slot: standby,
      episodeId: job.episodeId,
      scheduleItemId: job.scheduleItemId,
      generation: gen,
      ready: true,
    });
    // Kill old encode + drop its m3u8 ASAP (keeps stale credits out of wrong-slot polls).
    // Full .ts wipe ~8s — clients should already be on the new slot.
    if (oldSlot !== standby) {
      this.ffmpeg.scheduleRetireSlot(key, oldSlot, 8_000);
    }
    return 'promoted';
  }

  /** Poll until standby has .ts and active is near EOF (or dead), then promote. */
  watchStandbyPromote(slug: string, tz: string, profile: string): void {
    const key = `${slug}:${tz}:${profile}`;
    const prev = this.standbyWatchTimers.get(key);
    if (prev) clearTimeout(prev);

    let tries = 0;
    const tick = () => {
      this.standbyWatchTimers.delete(key);
      const standby = this.ffmpeg.getStandbySlot(key);
      if (!standby) return;
      const standbyJob = this.ffmpeg.getBySlot(key, standby);
      const active = this.ffmpeg.getActive(key);
      tries += 1;
      if (!standbyJob || !this.ffmpeg.isJobAlive(standbyJob)) {
        if (tries < 90) {
          const t = setTimeout(tick, 2_000);
          this.standbyWatchTimers.set(key, t);
        }
        return;
      }
      if (!standbyJob.ready) {
        const t = setTimeout(tick, 1_500);
        this.standbyWatchTimers.set(key, t);
        return;
      }
      const activeAlive = !!(active && this.ffmpeg.isJobAlive(active));
      // Switch only at true EOF window (~12s) — not −60s nearEnd (skipped last minute).
      let nearEnd = !activeAlive;
      if (activeAlive && active?.durationSec && active.startedAt) {
        const left =
          active.durationSec - (Date.now() - active.startedAt) / 1000;
        nearEnd = left <= 12;
      }
      if (!nearEnd && tries < 180) {
        const t = setTimeout(tick, 1_500);
        this.standbyWatchTimers.set(key, t);
        return;
      }
      void this.promoteStandby(slug, tz, profile);
    };
    const t = setTimeout(tick, 2_000);
    this.standbyWatchTimers.set(key, t);
  }

  /**
   * Continuous seam would start the next row while the guide is still on an
   * earlier slot (short file / early EOF). Hold encode and retry when the grid
   * catches up — otherwise air drifts ahead over the day.
   */
  holdForWallCatchUp(
    slug: string,
    tz: string,
    profile: string,
    completedEpisodeIds: number[],
    waitMs: number,
  ): void {
    const key = `${slug}:${tz}:${profile}`;
    const prev = this.aheadHoldTimers.get(key);
    if (prev) clearTimeout(prev);

    const clamped = Math.min(
      Math.max(Math.floor(waitMs), 3_000),
      45 * 60 * 1000,
    );
    this.logger.warn(
      `[${key}] air ahead of guide — hold ${Math.round(clamped / 1000)}s ` +
        `before next (done ep=${completedEpisodeIds.join(',')})`,
    );
    this.realtime.emitHint(slug, 'wait', {
      status: 'seam',
      // No chyron — client stays silent while buffer may still play.
    });
    // Do NOT stop ffmpeg — that freezes the CRT on the last frame for the whole hold.
    // Just delay starting the next owed row until the guide catches up.

    const timer = setTimeout(() => {
      this.aheadHoldTimers.delete(key);
      this.logger.log(
        `[${key}] guide catch-up hold done — continue after ep=${completedEpisodeIds.join(',')}`,
      );
      void this.continueEncode(slug, tz, profile, {
        completedEpisodeIds,
      }).catch((e) =>
        this.logger.warn(`[${key}] ahead-hold continue failed: ${e}`),
      );
    }, clamped);
    this.aheadHoldTimers.set(key, timer);
  }

  clearAheadHold(key: string): void {
    const t = this.aheadHoldTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.aheadHoldTimers.delete(key);
    }
  }

  clearSlotEndCatchUp(key: string): void {
    const t = this.slotEndTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.slotEndTimers.delete(key);
    }
  }

  /**
   * Fire when the guide leaves `scheduleItemId`. If we are still encoding that
   * row, stop and jump to wall-clock (same as F5 /start catch-up).
   */
  armSlotEndCatchUp(
    slug: string,
    tz: string,
    profile: string,
    scheduleItemId: number,
    episodeId: number,
    waitMs: number,
  ): void {
    const key = `${slug}:${tz}:${profile}`;
    this.clearSlotEndCatchUp(key);
    const clamped = Math.min(
      Math.max(Math.floor(waitMs), 400),
      3 * 60 * 60 * 1000,
    );
    this.logger.log(
      `[${key}] arm slot-end catch-up in ${Math.round(clamped / 1000)}s ` +
        `(item=${scheduleItemId} ep=${episodeId})`,
    );
    const timer = setTimeout(() => {
      this.slotEndTimers.delete(key);
      void this.catchUpIfPastSlot(slug, tz, profile, scheduleItemId, episodeId);
    }, clamped);
    this.slotEndTimers.set(key, timer);
  }

  private async catchUpIfPastSlot(
    slug: string,
    tz: string,
    profile: string,
    scheduleItemId: number,
    episodeId: number,
  ): Promise<void> {
    const key = `${slug}:${tz}:${profile}`;
    const job = this.ffmpeg.getActive(key);
    if (!job || !this.ffmpeg.isJobAlive(job)) return;
    if (job.scheduleItemId !== scheduleItemId && job.episodeId !== episodeId) {
      return;
    }

    const channel = await this.channels.findOne({ slug, isActive: true });
    if (!channel) return;
    const day = await this.loadScheduleDay(channel.id, tz);
    if (!day?.scheduleItems?.length) return;
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const date = calendarDateInTz(tz);
    const airStart = windowStartAt(date, airWindowStart, tz);
    const wall = findRemainingPlaylist(day.scheduleItems, airStart);
    if (!wall?.length) return;
    const cursorItem = day.scheduleItems.find((i) => i.id === scheduleItemId);
    if (!cursorItem) return;
    if (wall[0].item.order <= cursorItem.order) {
      // Guide still on this slot (or we drifted ahead) — re-arm for remaining.
      const left = msUntilScheduleItemEnd(
        day.scheduleItems,
        scheduleItemId,
        airStart,
      );
      if (left > 1000) {
        this.armSlotEndCatchUp(
          slug,
          tz,
          profile,
          scheduleItemId,
          episodeId,
          left,
        );
      }
      return;
    }

    this.logger.warn(
      `[${key}] slot ended on guide (ep=${episodeId}) but encode still live — catch up to ` +
        `ep=${wall[0].item.episode?.id ?? wall[0].item.episodeId}`,
    );
    this.ffmpeg.stopChannel(key);
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const dir = join(streamRoot, streamFolderName(slug, tz, profile));
    await markAirAhead(
      dir,
      date,
      [episodeId],
      scheduleItemId != null ? [scheduleItemId] : undefined,
    );
    await clearAirFinish(dir);
    await this.withChannelLock(key, async () => {
      await this.runEncode(slug, tz, profile, false, 'wall-clock', {
        completedEpisodeIds: [episodeId],
      });
    });
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
  isBridgeEncodeJob = isBridgeEncodeJob;
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
    this.logger.log(`[${key}] end of air — stop + clear HLS (both slots)`);
    this.clearAheadHold(key);
    this.clearSlotEndCatchUp(key);
    const watch = this.standbyWatchTimers.get(key);
    if (watch) clearTimeout(watch);
    this.standbyWatchTimers.delete(key);
    // Tell clients to stop HLS before wipe — otherwise 503/404 storm + /start spam.
    this.realtime.emitStatus(slug, {
      status: 'off',
      hint: 'none',
      message: 'Эфир на сегодня закончен',
    });
    this.ffmpeg.stopChannel(key);
    // Clear channel root + both slot dirs
    await this.ffmpeg.clearHlsFolder(join(dir, 'a'));
    await this.ffmpeg.clearHlsFolder(join(dir, 'b'));
    await this.ffmpeg.clearHlsFolder(dir);
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
      /** Intentional mid-window handoff (solo→bridge). Keep HLS, no crash counter. */
      rolling?: boolean;
    },
  ): Promise<'live' | 'off' | 'hold'> {
    const key = `${slug}:${tz}:${profile}`;
    // Rolling resume / bridge — keep silent; client must not flash a TV chyron
    // while HLS buffer still plays the previous .ts.
    const silentSeam = !!opts?.resumeCursor || !!opts?.rolling;
    // Do NOT emit "Подключаем эфир…" before we know the outcome — end-of-day
    // continueEncode often returns off, and the early wait caused a chyron +
    // 503 storm while HLS was already being wiped.
    let outcome: 'live' | 'off' | 'hold' = 'live';
    try {
      outcome = await this.withChannelLock(key, () =>
        this.continueEncodeUnlocked(slug, tz, profile, opts),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/air-grid-hold/i.test(msg)) outcome = 'hold';
      else {
        // Transient encode/lock failure ≠ end of day — never push "закончен"
        // (client treats that as permanent OFF AIR + black screen).
        this.logger.warn(`[${key}] continueEncode failed: ${msg}`);
        outcome = 'hold';
        this.realtime.emitHint(slug, 'hard', {
          status: 'seam',
          message: 'Переподключаем эфир…',
        });
      }
    }
    if (outcome === 'off') {
      // shutdownChannelStream already emitted off before wipe; keep a late
      // echo for callers that skipped shutdown (lock/error → off).
      this.realtime.emitStatus(slug, {
        status: 'off',
        hint: 'none',
        message: 'Эфир на сегодня закончен',
      });
    } else if (outcome === 'live') {
      // Do NOT hard-reattach immediately — folder may still be wiping/preparing
      // (client would hot/hard against 404 and loop). Wait until playlist is on disk.
      if (!silentSeam) {
        this.realtime.emitHint(slug, 'wait', {
          status: 'seam',
          message: 'Подключаем эфир…',
        });
      }
      void this.emitHardWhenPlaylistReady(slug, tz, profile, {
        // Rolling/append: no hot remanifest (micro-repeats). Still hard if encode dies.
        preferHot: false,
        silentOk: silentSeam,
      });
    }
    // hold: wait hint already active
    return outcome;
  }

  /** After a seam encode starts — nudge client only once HLS exists. */
  private async emitHardWhenPlaylistReady(
    slug: string,
    tz: string,
    profile: string,
    opts?: { preferHot?: boolean; silentOk?: boolean },
  ): Promise<void> {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (this.ffmpeg.isFolderPreparing(folderName)) continue;
      const job = this.ffmpeg.get(key);
      if (!job || !this.ffmpeg.isJobAlive(job)) {
        // Always hard if encode died — silent must not leave CRT on last frame forever.
        this.realtime.emitHint(slug, 'hard', {
          status: 'idle',
          message: 'Переподключаем эфир…',
        });
        return;
      }
      if (job.ready && (await this.ffmpeg.isPlaylistFresh(job.dir))) {
        // Silent append seam — hls.js picks up new .ts via playlist poll; no client snap.
        if (opts?.silentOk) return;
        const hint = opts?.preferHot ? 'hot' : 'hard';
        this.realtime.emitHint(slug, hint, {
          status: 'live',
          episodeId: job.episodeId,
          ready: true,
        });
        return;
      }
    }
    this.logger.warn(`[${key}] playlist not ready after seam wait — hard anyway`);
    this.realtime.emitHint(slug, 'hard', {
      status: 'live',
    });
  }

  /** True if schedule still has a row after these completed episode ids. */
  async hasNextAfterCompleted(
    slug: string,
    tz: string,
    completedEpisodeIds: number[],
    scheduleItemId?: number,
  ): Promise<boolean> {
    if (!completedEpisodeIds.length) return false;
    const channel = await this.channels.findOne({ slug, isActive: true });
    if (!channel) return false;
    const day = await this.loadScheduleDay(channel.id, tz);
    if (!day?.scheduleItems?.length) return false;
    const next = findPlaylistAfterCompleted(
      day.scheduleItems,
      completedEpisodeIds,
      scheduleItemId,
    );
    return !!next?.length;
  }

  private async continueEncodeUnlocked(
    slug: string,
    tz: string,
    profile: string,
    opts?: {
      skipCurrent?: boolean;
      completedEpisodeIds?: number[];
      resumeCursor?: boolean;
      rolling?: boolean;
    },
  ): Promise<'live' | 'off' | 'hold'> {
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
        // Crash / mid-episode resume — re-encode same tail into the active slot (no concat bridge).
        if (opts.rolling) {
          this.logger.log(
            `[${key}] rolling resume ep=${finish.episodeId} rem≈${Math.round(finish.durationSec)}s (dual-slot, no bridge)`,
          );
          await this.runFinishEncode(slug, tz, profile, finish, false, {
            bridgeNext: false,
          });
          return 'live';
        }
        // Credits / short leftover — never re-encode the ending (loops JL credits → restart).
        if (finish.durationSec <= 120) {
          this.logger.warn(
            `[${key}] resume cursor on short tail ${finish.durationSec}s — advance past ${finish.episodeId}`,
          );
          this.crashResumeCounts.delete(key);
          await markAirAhead(
            dir,
            date,
            [finish.episodeId],
            finish.scheduleItemId != null
              ? [finish.scheduleItemId]
              : undefined,
          );
          await clearAirFinish(dir);
          if (inWindow) {
            const append = await this.ffmpeg.isPlaylistAppendable(dir);
            await this.runEncode(slug, tz, profile, append, 'wall-clock', {
              skipCurrent: true,
              completedEpisodeIds: [finish.episodeId],
            });
            return 'live';
          }
          await this.shutdownChannelStream(slug, tz, profile);
          return 'off';
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
          await markAirAhead(
            dir,
            date,
            [finish.episodeId],
            finish.scheduleItemId != null
              ? [finish.scheduleItemId]
              : undefined,
          );
          await clearAirFinish(dir);
          if (inWindow && nextAfter?.length) {
            const append = await this.ffmpeg.isPlaylistAppendable(dir);
            await this.runEncode(slug, tz, profile, append, 'wall-clock', {
              skipCurrent: true,
              completedEpisodeIds: [finish.episodeId],
            });
            return 'live';
          }
          // No next row (or past window) → off air
          await this.shutdownChannelStream(slug, tz, profile);
          return 'off';
        }
        this.logger.log(
          `[${key}] resume cursor after crash/handoff episode=${finish.episodeId} (try ${crashes})`,
        );
        // Keep HLS when possible — wipe = black screen on the TV.
        const append = await this.ffmpeg.isPlaylistAppendable(dir);
        await this.runFinishEncode(slug, tz, profile, finish, append, {
          bridgeNext: false,
        });
        return 'live';
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
        await markAirAhead(
          dir,
          date,
          opts.completedEpisodeIds,
          finish?.scheduleItemId != null
            ? [finish.scheduleItemId]
            : undefined,
        );
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
            const wall = findRemainingPlaylist(day.scheduleItems, airStart) ?? [];
            const wallEp =
              wall[0]?.item.episode?.id ?? wall[0]?.item.episodeId ?? -1;
            // Last file finished early while guide still in that slot — don't OFF AIR yet
            // (Редакай кончился → off → reload restart). Hold until the slot ends.
            if (wall.length && seamDone.includes(wallEp)) {
              const waitMs = Math.max(3_000, (wall[0].durationSec || 1) * 1000);
              this.logger.log(
                `[${key}] end of schedule but guide still in ep=${wallEp} — hold ${Math.round(waitMs / 1000)}s`,
              );
              this.holdForWallCatchUp(slug, tz, profile, seamDone, waitMs);
              return 'hold';
            }
            if (!wall.length) {
              this.logger.log(
                `[${key}] end of schedule after ep=${seamDone.join(',')} → off air`,
              );
              await this.shutdownChannelStream(slug, tz, profile);
              return 'off';
            }
            // Guide already elsewhere — fall through to runEncode (wall/seq).
          }
        }

        // Prefer append on seams: after ffmpeg kill segments look "cold", but
        // wiping m3u8 → nginx 503 mid-watch. Intact playlist refs are enough.
        const append = await this.ffmpeg.isPlaylistAppendable(dir);
        if (!append) {
          this.logger.warn(
            `[${key}] continue: playlist not appendable — cold HLS start`,
          );
        }
        await this.runEncode(slug, tz, profile, append, 'wall-clock', {
          skipCurrent: !!opts?.skipCurrent,
          completedEpisodeIds: opts?.completedEpisodeIds,
        });
        return 'live';
      }

      if (opts?.skipCurrent) {
        this.logger.warn(`[${key}] stall during finish → off air`);
        await this.shutdownChannelStream(slug, tz, profile);
        return 'off';
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
            return 'off';
          }
        } else if (finish && opts.completedEpisodeIds.includes(finish.episodeId)) {
          this.logger.log(`[${key}] last cartoon completed → off air`);
          await this.shutdownChannelStream(slug, tz, profile);
          return 'off';
        }
      }

      if (overrun) {
        this.logger.log(`[${key}] past limit — continue finishing cartoon`);
        await this.runEncode(slug, tz, profile, true, 'wall-clock', {
          onlyCurrent: true,
          persistFinish: true,
          completedEpisodeIds: opts?.completedEpisodeIds,
        });
        return 'live';
      }

      if (finish) {
        this.logger.log(`[${key}] last cartoon completed → off air`);
        await this.shutdownChannelStream(slug, tz, profile);
        return 'off';
      }

      await this.shutdownChannelStream(slug, tz, profile);
      return 'off';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Early EOF vs guide — holdForWallCatchUp already armed a timer; do not wipe it.
      if (/air-grid-hold/i.test(msg)) {
        this.logger.log(`[${slug}] continue → grid hold (waiting for schedule)`);
        return 'hold';
      }
      this.logger.warn(
        `[${slug}] continue ended (${msg}) — clear HLS`,
      );
      await this.shutdownChannelStream(slug, tz, profile);
      return 'off';
    }
  }

  /** Resume after restart: solo episode into active dual-slot (no concat bridge). */
  async runFinishEncode(
    slug: string,
    tz: string,
    profile: string,
    finish: AirFinishState,
    append: boolean,
    opts?: { bridgeNext?: boolean },
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
          await markAirAhead(
            dir,
            date,
            [finish.episodeId],
            finish.scheduleItemId != null
              ? [finish.scheduleItemId]
              : undefined,
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
        await markAirAhead(
          dir,
          date,
          [finish.episodeId],
          finish.scheduleItemId != null
            ? [finish.scheduleItemId]
            : undefined,
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
      await markAirAhead(
        dir,
        date,
        [finish.episodeId],
        finish.scheduleItemId != null
          ? [finish.scheduleItemId]
          : undefined,
      );
      await clearAirFinish(dir);
      return this.runEncode(slug, tz, profile, false, 'wall-clock', {
        completedEpisodeIds: [finish.episodeId],
      });
    }

    // Catch up inpoint to wall-clock when guide already left — see armSlotEndCatchUp.
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
      await markAirAhead(
        dir,
        date,
        [finish.episodeId],
        finish.scheduleItemId != null
          ? [finish.scheduleItemId]
          : undefined,
      );
      await clearAirFinish(dir);
      return this.runEncode(slug, tz, profile, false, 'wall-clock', {
        completedEpisodeIds: [finish.episodeId],
      });
    }
    segments = finishClamp.segments;
    updated.inpointSec = segments[0].inpointSec;
    updated.durationSec = segments[0].durationSec;
    if (finishClamp.fileDurSec != null) {
      await this.runner.syncDurationsFromProbe(
        slug,
        finish.episodeId,
        finish.scheduleItemId,
        finishClamp.fileDurSec,
      );
    }
    await writeAirFinish(dir, updated);

    // Dual-slot: never concat bridge — encode solo tail; standby prep handles the next cartoon.
    if (opts?.bridgeNext) {
      this.logger.log(
        `[${key}] finish: bridgeNext ignored (dual-slot) rem≈${Math.round(updated.durationSec)}s`,
      );
    }

    const encodeStartedAt = Date.now();
    const remainingAtStart = updated.durationSec;
    const channelKey = key;
    const slot = this.ffmpeg.getActiveSlot(channelKey);
    const jobKey = streamJobKey(slug, tz, profile, slot);
    const slotFolder = streamSlotFolder(slug, tz, profile, slot);

    const job = await this.ffmpeg.startHls({
      key: jobKey,
      streamRoot,
      folderName: slotFolder,
      segments,
      append: false,
      rollingHandoff: false,
      slot,
      channelKey,
      onStandbyPrep: () => {
        if (this.ffmpeg.getActiveSlot(channelKey) !== slot) return;
        if (this.ffmpeg.getStandbySlot(channelKey)) return;
        void this.spawnStandby(slug, tz, profile, {
          completedEpisodeIds: [finish.episodeId],
        });
      },
      onNaturalEnd: ({ rolling }) => {
        if (rolling) {
          void this.continueEncode(slug, tz, profile, {
            resumeCursor: true,
            rolling: true,
          });
          return;
        }
        const standby = this.ffmpeg.getStandbySlot(channelKey);
        const standbyJob = standby
          ? this.ffmpeg.getBySlot(channelKey, standby)
          : undefined;
        if (
          standbyJob &&
          this.ffmpeg.isJobAlive(standbyJob) &&
          standbyJob.ready
        ) {
          void this.promoteStandby(slug, tz, profile);
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
        const nearEof = left <= 20;
        // Near EOF hang — advance only in the last seconds; post-credits need room.
        if (elapsed < 45 && !shortTail && !nearEof) {
          this.logger.warn(
            `[${key}] finish stall during seek (${Math.round(elapsed)}s) — retry`,
          );
          void this.continueEncode(slug, tz, profile, {
            resumeCursor: true,
            rolling: true,
          });
          return;
        }
        const nearEnd =
          shortTail || nearEof || elapsed >= Math.max(0, remainingAtStart - 20);
        void (async () => {
          if (nearEnd && finish.scheduleItemId != null) {
            const past = await this.guidePastScheduleItem(
              slug,
              tz,
              finish.scheduleItemId,
            );
            if (!past) {
              this.logger.warn(
                `[${key}] finish near-EOF stall but guide still in slot — resume`,
              );
              void this.continueEncode(slug, tz, profile, {
                resumeCursor: true,
                rolling: true,
              });
              return;
            }
          }
          void this.continueEncode(slug, tz, profile, {
            skipCurrent: nearEnd,
            completedEpisodeIds: nearEnd ? [finish.episodeId] : undefined,
          });
        })();
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
    job.slot = slot;
    job.channelKey = channelKey;
    this.ffmpeg.setActiveSlot(channelKey, slot);

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
      targetSlot?: 'a' | 'b';
      asStandby?: boolean;
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
