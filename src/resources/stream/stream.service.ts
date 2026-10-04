import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { AIR_WINDOW_START, STREAM_URL_PREFIX } from '@constants';
import { ChannelsService } from '../channels/channels/channels.service';
import { FfmpegService } from './ffmpeg.service';
import {
  clearAirFinish,
  readAirFinish,
  writeAirFinish,
} from './air-finish.state';
import {
  clearAirAhead,
  markAirAhead,
  pruneAirAheadIds,
  readAirAhead,
  writeAirAhead,
} from './air-ahead.state';
import {
  calendarDateInTz,
  findRemainingPlaylist,
  isFinishingOverrun,
  isWithinAirWindow,
  parseStreamKey,
  streamFolderName,
  windowStartAt,
} from './stream-air.util';
import { access } from 'fs/promises';
import { join } from 'path';
import { StreamEncodeService } from './stream-encode.service';
import { jobResponse } from './stream-encode.helpers';
import {
  StreamRealtimeService,
  type StreamSocketStatus,
} from './stream-realtime.service';

/**
 * End-of-air priority:
 * 1) Integrity of the current/last cartoon — play it through to the end.
 * 2) Only when the cartoon truly finished → off air + wipe HLS.
 * air-finish.json survives Nest restart while the frontend drains the tail.
 */
@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly ffmpeg: FfmpegService,
    private readonly encode: StreamEncodeService,
    private readonly realtime: StreamRealtimeService,
  ) {}

  async start(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    try {
      const result = await this.encode.withChannelLock(key, () =>
        this.startUnlocked(slug, tz, profile),
      );
      void this.publishSocketStatus(slug, tz, profile);
      return result;
    } catch (e) {
      // Ahead of guide — hold timer already armed; do NOT treat as OFF AIR.
      if (this.isAirGridHoldError(e)) {
        this.logger.log(`[${key}] /start → grid hold (waiting for schedule)`);
        const hold = this.holdStartResponse(slug);
        this.realtime.emitHint(slug, 'wait', {
          status: 'seam',
        });
        return hold;
      }
      // End of schedule / outside window — soft 200 for the guest UI (no console 400).
      if (this.isOffAirError(e)) {
        this.logger.log(`[${key}] /start → off air`);
        const off = this.offAirStartResponse(slug);
        this.realtime.emitStatus(slug, {
          status: 'off',
          hint: 'none',
          message: off.message,
        });
        return off;
      }
      throw e;
    }
  }

  private isAirGridHoldError(e: unknown): boolean {
    if (!(e instanceof BadRequestException)) return false;
    const body = e.getResponse();
    const msg =
      typeof body === 'string'
        ? body
        : body && typeof body === 'object' && 'message' in body
          ? String((body as { message?: unknown }).message)
          : e.message;
    return /air-grid-hold/i.test(msg);
  }

  private isOffAirError(e: unknown): boolean {
    if (!(e instanceof BadRequestException)) return false;
    const body = e.getResponse();
    const msg =
      typeof body === 'string'
        ? body
        : body && typeof body === 'object' && 'message' in body
          ? String((body as { message?: unknown }).message)
          : e.message;
    // air-grid-hold = waiting for schedule, NOT end of day
    return /off air|не в эфире/i.test(msg);
  }

  private holdStartResponse(slug: string) {
    return {
      channel: slug,
      streamUrl: null as string | null,
      ready: false,
      playable: false,
      status: 'starting' as const,
      pollAfterMs: 5000,
      message: 'Эфир есть, подстраиваем сетку…',
    };
  }

  private offAirStartResponse(slug: string) {
    return {
      channel: slug,
      streamUrl: null as string | null,
      ready: false,
      playable: false,
      status: 'off' as const,
      message: 'Сейчас не в эфире',
    };
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
    const slotDir = () => this.ffmpeg.activeHlsDir(streamRoot, folderName, key);

    // 1) Live encode — reconnect, BUT do not serve one stuck on the ending.
    const existing = this.ffmpeg.get(key);
    if (existing && this.ffmpeg.isJobAlive(existing)) {
      const stallSec = Number(this.config.get('STREAM_STALL_SEC', 15));
      const ageMs = await this.ffmpeg.segmentAgeMs(existing.dir);
      const stalled =
        ageMs != null && ageMs >= Math.max(8, stallSec) * 1000;

      if (stalled) {
        const nearEnd = this.encode.isJobNearEpisodeEnd(existing);
        // Dual-slot / bridge: stall /start must not kill the warming handoff.
        if (
          this.encode.isBridgeEncodeJob(existing) ||
          this.ffmpeg.getStandbySlot(key)
        ) {
          this.logger.warn(
            `[${key}] /start on stalled encode during dual-slot/bridge — keep`,
          );
          existing.lastAccessAt = Date.now();
          this.ffmpeg.touchChannel(key);
          return jobResponse(this.config, slug, existing);
        }
        // Mid-episode we do not jump ahead — only restart from wall-clock/cursor.
        // Near the ending — skip only if guide already left; else keep (no rewind).
        this.logger.warn(
          `[${key}] /start on stalled encode (age=${Math.round((ageMs ?? 0) / 1000)}s` +
            `${nearEnd ? ', near end' : ', mid'})`,
        );
        if (nearEnd) {
          const guidePast =
            existing.scheduleItemId == null ||
            (await this.shouldCatchUpPastSlot(
              slug,
              tz,
              existing.scheduleItemId,
              existing.episodeId ?? 0,
            ));
          if (!guidePast) {
            this.logger.warn(
              `[${key}] stalled near end but guide in slot — keep encode`,
            );
            existing.lastAccessAt = Date.now();
            this.ffmpeg.touchChannel(key);
            return jobResponse(this.config, slug, existing);
          }
          this.ffmpeg.stopChannel(key);
          const hlsDir =
            existing.dir ??
            this.ffmpeg.activeHlsDir(streamRoot, folderName, key);
          const append = await this.ffmpeg.isPlaylistAppendable(hlsDir);
          if (existing.episodeId) {
            await markAirAhead(
              dir,
              calendarDateInTz(tz),
              [existing.episodeId],
              existing.scheduleItemId != null
                ? [existing.scheduleItemId]
                : undefined,
            );
          }
          await clearAirFinish(dir);
          return this.encode.runEncode(slug, tz, profile, append, 'wall-clock', {
            skipCurrent: true,
            completedEpisodeIds: existing.episodeId
              ? [existing.episodeId]
              : undefined,
          });
        }
        this.ffmpeg.stopChannel(key);
        // Prefer append against the *slot* playlist — channel root has no m3u8.
        const hlsDir =
          existing.dir ??
          this.ffmpeg.activeHlsDir(streamRoot, folderName, key);
        const append = await this.ffmpeg.isPlaylistAppendable(hlsDir);
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
          const remain = Math.max(
            1,
            Math.floor(existing.durationSec - elapsed),
          );
          // Credits stub — never re-encode a tiny leftover via /start (was 90s → cut endings).
          if (remain <= 25) {
            await markAirAhead(
              dir,
              calendarDateInTz(tz),
              [existing.episodeId],
              existing.scheduleItemId != null
                ? [existing.scheduleItemId]
                : undefined,
            );
            await clearAirFinish(dir);
            return this.encode.runEncode(slug, tz, profile, append, 'wall-clock', {
              completedEpisodeIds: [existing.episodeId],
            });
          }
          const finish = {
            date: calendarDateInTz(tz),
            episodeId: existing.episodeId,
            scheduleItemId: existing.scheduleItemId,
            mediaPath: existing.mediaPath,
            relativePath: existing.relativePath ?? '',
            inpointSec: Math.floor((existing.offsetSec ?? 0) + elapsed),
            durationSec: remain,
            source: existing.source ?? 'regular',
            policy: 'continuous' as const,
            generation: 1,
            savedAt: new Date().toISOString(),
          };
          await writeAirFinish(dir, finish);
          return this.encode.runFinishEncode(slug, tz, profile, finish, append);
        }
        return this.encode.runEncode(slug, tz, profile, append, 'wall-clock');
      }

      // Live but already in credits — reconnecting must NOT rewind the ending.
      // Bridge (A-tail+B-head): durationSec is only A — NEVER wall-clock kill mid-B.
      if (this.encode.isBridgeEncodeJob(existing)) {
        this.logger.log(
          `[${key}] /start on live seam bridge — keep encode (no wall-clock)`,
        );
        existing.lastAccessAt = Date.now();
        this.ffmpeg.touchChannel(key);
        return jobResponse(this.config, slug, existing);
      }

      // Dual-slot standby warming — keep active; promote will switch.
      if (this.ffmpeg.getStandbySlot(key)) {
        this.logger.log(
          `[${key}] /start during dual-slot standby — keep encode`,
        );
        existing.lastAccessAt = Date.now();
        this.ffmpeg.touchChannel(key);
        return jobResponse(this.config, slug, existing);
      }

      const windowSec =
        existing.encodeWindowSec && existing.encodeWindowSec > 0
          ? existing.encodeWindowSec
          : (existing.durationSec ?? 0);
      const remainLive = Math.max(
        0,
        windowSec -
          (Date.now() - (existing.startedAt ?? Date.now())) / 1000,
      );
      if (
        this.encode.isJobNearEpisodeEnd(existing) ||
        remainLive <= 25
      ) {
        const gridMovedOn =
          existing.scheduleItemId != null &&
          (await this.shouldCatchUpPastSlot(
            slug,
            tz,
            existing.scheduleItemId,
            existing.episodeId ?? 0,
          ));
        if (!gridMovedOn) {
          // Guide still here — wall-clock resync rewound credits ("ending→rewind→ending").
          // Keep the live encode; dual-slot/natural EOF will advance.
          this.logger.warn(
            `[${key}] /start on live near end but guide still in slot — keep encode`,
          );
          existing.lastAccessAt = Date.now();
          this.ffmpeg.touchChannel(key);
          return jobResponse(this.config, slug, existing);
        }
        this.logger.warn(
          `[${key}] /start on live encode near end (≈${Math.round(remainLive)}s left) — advance`,
        );
        this.ffmpeg.stopChannel(key);
        if (existing.episodeId) {
          await markAirAhead(
            dir,
            calendarDateInTz(tz),
            [existing.episodeId],
            existing.scheduleItemId != null
              ? [existing.scheduleItemId]
              : undefined,
          );
        }
        await clearAirFinish(dir);
        return this.encode.runEncode(slug, tz, profile, await this.ffmpeg.isPlaylistAppendable(slotDir()), 'wall-clock', {
          completedEpisodeIds: existing.episodeId
            ? [existing.episodeId]
            : undefined,
        });
      }

      existing.lastAccessAt = Date.now();
      this.ffmpeg.touchChannel(key);

      // Live encode but grid already moved past this slot (reload stuck on JL while TD is on).
      if (existing.episodeId != null && existing.scheduleItemId != null) {
        const catchUp = await this.shouldCatchUpPastSlot(
          slug,
          tz,
          existing.scheduleItemId,
          existing.episodeId,
        );
        if (catchUp) {
          this.logger.warn(
            `[${key}] /start live encode behind wall-clock (ep=${existing.episodeId}) — catch up`,
          );
          this.ffmpeg.stopChannel(key);
          await markAirAhead(
            dir,
            calendarDateInTz(tz),
            [existing.episodeId],
            existing.scheduleItemId != null
              ? [existing.scheduleItemId]
              : undefined,
          );
          await clearAirFinish(dir);
          return this.encode.runEncode(slug, tz, profile, await this.ffmpeg.isPlaylistAppendable(slotDir()), 'wall-clock', {
            completedEpisodeIds: [existing.episodeId],
          });
        }
      }

      return jobResponse(this.config, slug, existing);
    }

    const date = calendarDateInTz(tz);

    // 2) Resume the cartoon we were encoding (idle kill / Nest restart / cold HLS).
    // Never fall back to wall-clock while the cursor is still valid — that jumps
    // W.I.T.C.H. ending → Dragon Hunters just because the schedule moved on.
    // Exception: cursor slot fully over on the grid → catch up (reload must not stick).
    const finish = await readAirFinish(dir);
    if (finish) {
      if (finish.date && finish.date !== date) {
        this.logger.log(`[${key}] stale air-finish date=${finish.date} → drop`);
        await clearAirFinish(dir);
      } else if (finish.durationSec <= 90) {
        // Cursor parked on credits. Only advance if the guide already left this slot.
        // If wall-clock still sits here, air drifted ahead — resync to grid (reload fix).
        const gridMovedOn =
          finish.scheduleItemId != null &&
          (await this.shouldCatchUpPastSlot(
            slug,
            tz,
            finish.scheduleItemId,
            finish.episodeId,
          ));
        if (!gridMovedOn) {
          this.logger.log(
            `[${key}] credits stub but guide still in slot — wall-clock resync ` +
              `(ep=${finish.episodeId})`,
          );
          await clearAirFinish(dir);
          await clearAirAhead(dir);
          const appendFresh = await this.ffmpeg.isPlaylistFresh(slotDir());
          return this.encode.runEncode(
            slug,
            tz,
            profile,
            appendFresh,
            'wall-clock',
          );
        }
        this.logger.log(
          `[${key}] air cursor credits stub remain=${finish.durationSec}s — advance past ${finish.episodeId}`,
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
        return this.encode.runEncode(slug, tz, profile, await this.ffmpeg.isPlaylistAppendable(slotDir()), 'wall-clock', {
          completedEpisodeIds: [finish.episodeId],
        });
      } else if (
        finish.scheduleItemId != null &&
        (await this.shouldCatchUpPastSlot(
          slug,
          tz,
          finish.scheduleItemId,
          finish.episodeId,
        ))
      ) {
        this.logger.log(
          `[${key}] air cursor ep=${finish.episodeId} behind wall-clock — catch up`,
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
        return this.encode.runEncode(slug, tz, profile, await this.ffmpeg.isPlaylistAppendable(slotDir()), 'wall-clock', {
          completedEpisodeIds: [finish.episodeId],
        });
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
          const cold = !(await this.ffmpeg.isPlaylistFresh(slotDir()));
          this.logger.log(
            `[${key}] resume encode cursor episode=${finish.episodeId} +${finish.inpointSec}s` +
              ` remain=${finish.durationSec}s policy=${finish.policy ?? 'continuous'}` +
              `${cold ? ' (cold HLS)' : ''}`,
          );
          // Cold HLS: never append — wiped folder + append_list = zombie SN 404s.
          const append = await this.ffmpeg.isPlaylistAppendable(slotDir());
          return this.encode.runFinishEncode(
            slug,
            tz,
            profile,
            finish,
            append,
            { bridgeNext: false },
          );
        }
      }
    }

    // Cold start / return to channel: append only to hot HLS.
    // Otherwise stale live-edge + mid-seek = jump into the future and back.
    // Prefer wall-clock truth — continuous air may have drifted ahead; reload
    // must restore schedule accuracy (not keep racing via air-ahead skip).
    const append = await this.ffmpeg.isPlaylistFresh(slotDir());
    await clearAirAhead(dir);
    this.encode.clearAheadHold(`${slug}:${tz}:${profile}`);
    return this.encode.runEncode(slug, tz, profile, append, 'wall-clock');
  }

  /**
   * @deprecated kept for prune helpers / diagnostics — /start no longer skips via ahead.
   */
  private async completedAheadForStart(
    dir: string,
    slug: string,
    tz: string,
  ): Promise<number[]> {
    const ahead = await readAirAhead(dir);
    const date = calendarDateInTz(tz);
    if (!ahead?.episodeIds?.length) return [];
    if (ahead.date !== date) {
      await clearAirAhead(dir);
      return [];
    }
    const channel = await this.channels.findOne({ slug, isActive: true });
    if (!channel) return ahead.episodeIds;
    const day = await this.encode.loadScheduleDay(channel.id, tz);
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const airStart = windowStartAt(date, airWindowStart, tz);
    const wall = findRemainingPlaylist(day?.scheduleItems, airStart);
    const wallOrder = wall?.[0]?.item.order;
    const pruned = pruneAirAheadIds(
      ahead.episodeIds,
      day?.scheduleItems,
      wallOrder,
    );
    if (pruned.length !== ahead.episodeIds.length) {
      if (!pruned.length) await clearAirAhead(dir);
      else {
        await writeAirAhead(dir, {
          ...ahead,
          episodeIds: pruned,
          savedAt: new Date().toISOString(),
        });
      }
    }
    return pruned;
  }

  /**
   * True when the schedule row we are encoding has already ended on the grid
   * (wall-clock sits on a later order) — /start must not keep serving it.
   * If cursor is AHEAD of wall-clock (file shorter than grid slot), keep cursor.
   */
  private async shouldCatchUpPastSlot(
    slug: string,
    tz: string,
    scheduleItemId: number,
    _episodeId: number,
  ): Promise<boolean> {
    const channel = await this.channels.findOne({ slug, isActive: true });
    if (!channel) return false;
    const day = await this.encode.loadScheduleDay(channel.id, tz);
    if (!day?.scheduleItems?.length) return false;
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const date = calendarDateInTz(tz);
    const airStart = windowStartAt(date, airWindowStart, tz);
    const wall = findRemainingPlaylist(day.scheduleItems, airStart);
    if (!wall?.length) return false;
    const cursorItem = day.scheduleItems.find((i) => i.id === scheduleItemId);
    if (!cursorItem) return false;
    // Behind grid → catch up. Ahead of grid (short file) → do NOT roll back.
    return wall[0].item.order > cursorItem.order;
  }

  /** Socket snapshot for TV client. */
  async socketStatus(
    slug: string,
    tz = 'Europe/Tallinn',
    profile = '720p',
  ): Promise<StreamSocketStatus> {
    const key = `${slug}:${tz}:${profile}`;
    const folderName = streamFolderName(slug, tz, profile);
    const job = this.ffmpeg.get(key);
    const preparing = this.ffmpeg.isFolderPreparing(folderName);
    const finish = await readAirFinish(
      join(this.config.getOrThrow<string>('STREAM_ROOT').trim(), folderName),
    );

    if (preparing || (job && this.ffmpeg.isJobAlive(job) && !job.ready)) {
      return {
        channel: slug,
        status: 'starting',
        hint: 'wait',
        episodeId: job?.episodeId ?? finish?.episodeId,
        scheduleItemId: job?.scheduleItemId ?? finish?.scheduleItemId,
        generation: finish?.generation,
        ready: false,
        message: 'Эфир есть, подготавливаем поток',
        at: new Date().toISOString(),
      };
    }

    if (job && this.ffmpeg.isJobAlive(job) && job.ready) {
      // Near EOF is handled by dual-slot switch hint — do NOT push hint=wait
      // (client flashes "Почти готово…" / loading over a still-playing cartoon).
      return {
        channel: slug,
        status: 'live',
        hint: 'none',
        episodeId: job.episodeId,
        scheduleItemId: job.scheduleItemId,
        generation: finish?.generation,
        ready: true,
        streamUrl: job.playlistUrl,
        slot: job.slot,
        at: new Date().toISOString(),
      };
    }

    if (finish) {
      return {
        channel: slug,
        status: 'idle',
        hint: 'hard',
        episodeId: finish.episodeId,
        scheduleItemId: finish.scheduleItemId,
        generation: finish.generation,
        ready: false,
        message: 'Кодировщик не запущен — нужен /start',
        at: new Date().toISOString(),
      };
    }

    return {
      channel: slug,
      status: 'idle',
      hint: 'hard',
      ready: false,
      at: new Date().toISOString(),
    };
  }

  /**
   * Client stuck on seam wait overlay — return actionable hint.
   * Only hot when playlist is actually on disk; preparing/missing → wait/hard.
   */
  async resolveSeamSync(
    slug: string,
    tz: string,
    profile: string,
  ): Promise<StreamSocketStatus> {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const hlsDir = this.ffmpeg.activeHlsDir(streamRoot, folderName, key);
    const preparing =
      this.ffmpeg.isFolderPreparing(folderName) ||
      this.ffmpeg.isFolderPreparing(`${folderName}/a`) ||
      this.ffmpeg.isFolderPreparing(`${folderName}/b`);
    const fresh = await this.ffmpeg.isPlaylistFresh(hlsDir);
    const status = await this.socketStatus(slug, tz, profile);

    if (status.status === 'off') {
      this.realtime.emitStatus(slug, status);
      return status;
    }

    if (preparing || (status.status === 'starting' && !fresh)) {
      const wait: StreamSocketStatus = {
        ...status,
        status: 'starting',
        hint: 'wait',
        ready: false,
        message: status.message ?? 'Эфир есть, подготавливаем поток',
      };
      this.realtime.emitStatus(slug, wait);
      return wait;
    }

    if (fresh && status.ready) {
      // Playlist is fine — do NOT hot-remanifest (causes short fragment restarts).
      // Client keeps polling HLS; only hard if they are truly stuck with no buffer.
      const ok: StreamSocketStatus = {
        ...status,
        hint: 'none',
        message: undefined,
      };
      this.realtime.emitStatus(slug, ok);
      return ok;
    }

    // No fresh HLS — need /start (or still encoding first segments).
    const job = this.ffmpeg.get(key);
    if (job && this.ffmpeg.isJobAlive(job)) {
      const wait: StreamSocketStatus = {
        ...status,
        status: 'starting',
        hint: 'wait',
        ready: false,
        message: 'Эфир есть, подготавливаем поток',
      };
      this.realtime.emitStatus(slug, wait);
      return wait;
    }

    const hard: StreamSocketStatus = {
      ...status,
      status: 'idle',
      hint: 'hard',
      ready: false,
      message: status.message ?? 'Переподключаем эфир…',
    };
    this.realtime.emitStatus(slug, hard);
    return hard;
  }

  /**
   * Client reports play trouble; server returns recover hint.
   * wait = seam/503, hot = remanifest, hard = /start+reattach.
   */
  async resolvePlayIssue(
    slug: string,
    tz: string,
    profile: string,
    issue: 'stall' | 'frag404' | 'playlist404' | 'buffering' | 'ended',
  ): Promise<StreamSocketStatus> {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const job = this.ffmpeg.get(key);
    const hlsDir = job?.dir ?? this.ffmpeg.activeHlsDir(streamRoot, folderName, key);
    const preparing =
      this.ffmpeg.isFolderPreparing(folderName) ||
      this.ffmpeg.isFolderPreparing(`${folderName}/a`) ||
      this.ffmpeg.isFolderPreparing(`${folderName}/b`);

    if (preparing) {
      const status = await this.socketStatus(slug, tz, profile);
      status.hint = 'wait';
      status.status = 'seam';
      this.realtime.emitStatus(slug, status);
      return status;
    }

    if (job && this.ffmpeg.isJobAlive(job)) {
      // Mid-bridge / mid-standby: keep encode — do not wall-clock kill.
      // Clear orphan standby flag if the warming job already died.
      const sb = this.ffmpeg.getStandbySlot(key);
      if (sb) {
        const sbJob = this.ffmpeg.getBySlot(key, sb);
        if (!sbJob || !this.ffmpeg.isJobAlive(sbJob)) {
          this.ffmpeg.setStandbySlot(key, undefined);
        }
      }
      if (
        this.encode.isBridgeEncodeJob(job) ||
        this.ffmpeg.getStandbySlot(key)
      ) {
        const status = await this.socketStatus(slug, tz, profile);
        status.hint = issue === 'buffering' ? 'none' : 'wait';
        status.status = 'seam';
        this.realtime.emitStatus(slug, status);
        this.logger.log(
          `[${key}] play-issue ${issue} during dual-slot seam — keep encode (hint=${status.hint})`,
        );
        return status;
      }

      const nearEnd = this.encode.isJobNearEpisodeEnd(job);
      const windowSec =
        job.encodeWindowSec && job.encodeWindowSec > 0
          ? job.encodeWindowSec
          : (job.durationSec ?? 0);
      const remain = Math.max(
        0,
        windowSec -
          (Date.now() - (job.startedAt ?? Date.now())) / 1000,
      );
      // Credits / EOF hang — advance only when guide left the slot (or tiny tail).
      // Early advance while guide still in-slot cut endings / caused rewind loops.
      if (nearEnd || remain <= 25 || issue === 'ended') {
        const guidePast =
          job.scheduleItemId == null ||
          (await this.shouldCatchUpPastSlot(
            slug,
            tz,
            job.scheduleItemId,
            job.episodeId ?? 0,
          ));
        if (!guidePast && remain > 12 && issue !== 'ended') {
          const status = await this.socketStatus(slug, tz, profile);
          status.hint = 'wait';
          status.status = 'seam';
          this.realtime.emitStatus(slug, status);
          this.logger.log(
            `[${key}] play-issue ${issue} near end but guide in slot — keep (≈${Math.round(remain)}s)`,
          );
          return status;
        }

        const completed = job.episodeId ? [job.episodeId] : [];
        const hasNext =
          completed.length > 0 &&
          (await this.encode.hasNextAfterCompleted(
            slug,
            tz,
            completed,
            job.scheduleItemId,
          ));
        this.ffmpeg.stopChannel(key);
        if (job.episodeId) {
          await markAirAhead(
            dir,
            calendarDateInTz(tz),
            [job.episodeId],
            job.scheduleItemId != null ? [job.scheduleItemId] : undefined,
          );
        }
        await clearAirFinish(dir);

        if (!hasNext) {
          this.logger.warn(
            `[${key}] play-issue ${issue} near end — last episode → off air`,
          );
          await this.encode.shutdownChannelStream(slug, tz, profile);
          const off: StreamSocketStatus = {
            channel: slug,
            status: 'off',
            hint: 'none',
            episodeId: job.episodeId,
            at: new Date().toISOString(),
            message: 'Эфир на сегодня закончен',
          };
          this.realtime.emitStatus(slug, off);
          return off;
        }

        this.logger.warn(
          `[${key}] play-issue ${issue} near end — advance`,
        );
        void this.encode
          .continueEncode(slug, tz, profile, {
            completedEpisodeIds: completed,
            skipCurrent: true,
          })
          .catch((e) =>
            this.logger.warn(`[${key}] play-issue advance failed: ${e}`),
          );
        const status: StreamSocketStatus = {
          channel: slug,
          status: 'seam',
          hint: 'wait',
          episodeId: job.episodeId,
          at: new Date().toISOString(),
          message: 'Подключаем эфир…',
        };
        this.realtime.emitStatus(slug, status);
        return status;
      }

      // Alive mid-episode with fresh HLS.
      // buffering blip → none (avoid remanifest flicker).
      // stall / ended with stale .ts → hard (frozen credits logo).
      const fresh = await this.ffmpeg.isPlaylistFresh(hlsDir);
      if (issue === 'playlist404' || !fresh) {
        const wait: StreamSocketStatus = {
          channel: slug,
          status: 'seam',
          hint: 'wait',
          episodeId: job.episodeId,
          scheduleItemId: job.scheduleItemId,
          ready: false,
          message: 'Эфир есть, подготавливаем поток',
          at: new Date().toISOString(),
        };
        this.realtime.emitStatus(slug, wait);
        return wait;
      }
      if (issue === 'stall' || issue === 'ended') {
        const ageMs = await this.ffmpeg.segmentAgeMs(hlsDir);
        const stallSec = Number(this.config.get('STREAM_STALL_SEC', 15));
        if (ageMs != null && ageMs >= Math.max(8, stallSec) * 1000) {
          this.logger.warn(
            `[${key}] play-issue ${issue} — segments stale ${Math.round(ageMs / 1000)}s → hard`,
          );
          const hard: StreamSocketStatus = {
            channel: slug,
            status: 'live',
            hint: 'hard',
            episodeId: job.episodeId,
            scheduleItemId: job.scheduleItemId,
            ready: !!job.ready,
            at: new Date().toISOString(),
            message: 'Переподключаем эфир…',
          };
          this.realtime.emitStatus(slug, hard);
          return hard;
        }
      }
      const ok: StreamSocketStatus = {
        channel: slug,
        status: 'live',
        hint: 'none',
        episodeId: job.episodeId,
        scheduleItemId: job.scheduleItemId,
        ready: !!job.ready,
        at: new Date().toISOString(),
      };
      this.realtime.emitStatus(slug, ok);
      return ok;
    }

    // No job — ensure encode, hard reattach (or soft off if day ended).
    this.logger.warn(`[${key}] play-issue ${issue} — no job, /start`);
    try {
      const started = await this.start(slug, tz, profile);
      if (started?.status === 'off') {
        const off: StreamSocketStatus = {
          channel: slug,
          status: 'off',
          hint: 'none',
          at: new Date().toISOString(),
          message: started.message ?? 'Сейчас не в эфире',
        };
        this.realtime.emitStatus(slug, off);
        return off;
      }
    } catch (e) {
      this.logger.warn(`[${key}] play-issue start failed: ${e}`);
    }
    const hard: StreamSocketStatus = {
      channel: slug,
      status: 'starting',
      hint: 'hard',
      at: new Date().toISOString(),
    };
    this.realtime.emitStatus(slug, hard);
    return hard;
  }

  private async publishSocketStatus(
    slug: string,
    tz: string,
    profile: string,
  ): Promise<void> {
    try {
      const status = await this.socketStatus(slug, tz, profile);
      this.realtime.emitStatus(slug, status);
    } catch {
      /* ignore */
    }
  }

  stop(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    this.ffmpeg.stopChannel(key);
    return { channel: slug, key, stopped: true };
  }

  /** Viewer heartbeat (HLS / nginx auth_request) — keeps idle TTL from killing encode. */
  heartbeat(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    this.ffmpeg.touchChannel(key);
    const job = this.ffmpeg.get(key);
    if (job) {
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
    return this.encode.shutdownChannelStream(slug, tz, profile);
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
    const hours = this.encode.airTimeHours();
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();

    for (const job of this.ffmpeg.listJobs()) {
      try {
        const { slug, tz, profile } = parseStreamKey(job.key);
        const date = calendarDateInTz(tz);
        const airStart = windowStartAt(date, airWindowStart, tz);
        if (isWithinAirWindow(airStart, hours)) continue;

        const dir = join(streamRoot, streamFolderName(slug, tz, profile));

        if (this.ffmpeg.isJobAlive(job)) {
          await this.encode.ensureFinishFromJob(job, dir, date);
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

        await this.encode.shutdownChannelStream(slug, tz, profile);
      } catch (e) {
        this.logger.warn(`enforceAirWindow: ${e}`);
      }
    }
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
    const slot = job?.slot ?? this.ffmpeg.getActiveSlot(key);
    const slotDir = join(dir, slot);
    const streamUrl =
      job?.playlistUrl ??
      `${STREAM_URL_PREFIX}/${folderName}/${slot}/playlist.m3u8`;

    let hasPlaylist = false;
    try {
      await access(join(slotDir, 'playlist.m3u8'));
      hasPlaylist = true;
    } catch {
      try {
        await access(join(dir, 'playlist.m3u8'));
        hasPlaylist = true;
      } catch {
        hasPlaylist = false;
      }
    }
    const ageMs = hasPlaylist
      ? await this.ffmpeg.segmentAgeMs(slotDir).catch(() =>
          this.ffmpeg.segmentAgeMs(dir),
        )
      : null;
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
        if (started.status === 'off') {
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
            message: started.message ?? 'Сейчас не в эфире',
          };
        }
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
    const hours = this.encode.airTimeHours();
    const date = calendarDateInTz(tz);
    const airStart = windowStartAt(date, airWindowStart, tz);
    if (isWithinAirWindow(airStart, hours)) return true;

    const day = await this.encode.loadScheduleDay(channel.id, tz);
    if (day && isFinishingOverrun(day.scheduleItems, airStart, hours)) {
      return true;
    }

    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const finish = await readAirFinish(
      join(streamRoot, streamFolderName(slug, tz, profile)),
    );
    return !!finish;
  }
}
