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
  calendarDateInTz,
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
  ) {}

  async start(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    try {
      return await this.encode.withChannelLock(key, () =>
        this.startUnlocked(slug, tz, profile),
      );
    } catch (e) {
      // End of schedule / outside window — soft 200 for the guest UI (no console 400).
      if (this.isOffAirError(e)) {
        this.logger.log(`[${key}] /start → off air`);
        return this.offAirStartResponse(slug);
      }
      throw e;
    }
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
    return /off air|не в эфире/i.test(msg);
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

    // 1) Live encode — reconnect, BUT do not serve one stuck on the ending.
    const existing = this.ffmpeg.get(key);
    if (existing && this.ffmpeg.isJobAlive(existing)) {
      const stallSec = Number(this.config.get('STREAM_STALL_SEC', 15));
      const ageMs = await this.ffmpeg.segmentAgeMs(existing.dir);
      const stalled =
        ageMs != null && ageMs >= Math.max(8, stallSec) * 1000;

      if (stalled) {
        const nearEnd = this.encode.isJobNearEpisodeEnd(existing);
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
          return this.encode.runEncode(slug, tz, profile, append, 'wall-clock', {
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
          return this.encode.runFinishEncode(slug, tz, profile, finish, append);
        }
        return this.encode.runEncode(slug, tz, profile, append, 'wall-clock');
      }

      existing.lastAccessAt = Date.now();
      this.ffmpeg.touch(key);
      return jobResponse(this.config, slug, existing);
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
          return this.encode.runFinishEncode(slug, tz, profile, finish, false);
        }
      }
    }

    // Cold start / return to channel: append only to hot HLS.
    // Otherwise stale live-edge + mid-seek = jump into the future and back.
    const append = await this.ffmpeg.isPlaylistFresh(dir);
    return this.encode.runEncode(slug, tz, profile, append, 'wall-clock');
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
