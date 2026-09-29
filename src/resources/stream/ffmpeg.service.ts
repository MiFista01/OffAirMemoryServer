import { FfmpegJob } from '@app-types';
import { STREAM_IDLE_TTL_SEC, STREAM_URL_PREFIX } from '@constants';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { access, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { writeAirFinish, readAirFinish } from './air-finish.state';
import { calendarDateInTz, parseStreamKey } from './stream-air.util';

@Injectable()
export class FfmpegService implements OnModuleDestroy {
  private readonly logger = new Logger(FfmpegService.name);
  private readonly jobs = new Map<string, FfmpegJob>();
  private readonly stopped = new Set<string>();
  /** Serialize start/continue per key — avoids clear+spawn races. */
  private readonly startLocks = new Map<string, Promise<FfmpegJob>>();
  private readonly rollingHandoff = new Set<string>();
  private readonly stallSkip = new Set<string>();
  private readonly handoffTimers = new Map<string, NodeJS.Timeout>();

  /** Serialize folder wipes so /start cannot spawn into a half-deleted HLS dir. */
  private readonly clearLocks = new Map<string, Promise<void>>();

  constructor(private readonly config: ConfigService) {}

  /** Wait for any in-flight wipe on this key (call before writing new HLS). */
  async waitForClear(key: string): Promise<void> {
    const pending = this.clearLocks.get(key);
    if (pending) await pending.catch(() => undefined);
  }

  private enqueueClear(key: string, dir: string): Promise<void> {
    const prev = this.clearLocks.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        await this.clearHlsFolder(dir);
      });
    this.clearLocks.set(
      key,
      run.finally(() => {
        if (this.clearLocks.get(key) === run) this.clearLocks.delete(key);
      }),
    );
    return run;
  }

  get(key: string) {
    return this.jobs.get(key);
  }

  touch(key: string) {
    const job = this.jobs.get(key);
    if (job) job.lastAccessAt = Date.now();
  }

  /** Touch by HLS folder name (`slug_Europe-Tallinn_720p`) — from /stream requests. */
  touchByFolder(folderName: string): boolean {
    if (!folderName) return false;
    for (const job of this.jobs.values()) {
      if (
        job.dir.replace(/\\/g, '/').endsWith(`/${folderName}`) ||
        job.dir.endsWith(folderName) ||
        job.playlistUrl.includes(`/${folderName}/`)
      ) {
        job.lastAccessAt = Date.now();
        return true;
      }
    }
    return false;
  }

  /**
   * Encode is already running, but the playlist is not ready yet (seek).
   * Static middleware answers 503 instead of 404 — so hls.js does not get a Not Found storm.
   */
  isFolderPreparing(folderName: string): boolean {
    if (!folderName) return false;
    for (const job of this.jobs.values()) {
      if (!this.isAlive(job) || job.ready) continue;
      if (
        job.dir.replace(/\\/g, '/').endsWith(`/${folderName}`) ||
        job.dir.endsWith(folderName) ||
        job.playlistUrl.includes(`/${folderName}/`)
      ) {
        return true;
      }
    }
    return false;
  }

  async startHls(opts: {
    key: string;
    streamRoot: string;
    folderName: string;
    segments: { path: string; inpointSec: number; durationSec: number }[];
    append?: boolean;
    /** false when lookahead=0 (one long encode — handoff only hurts). */
    rollingHandoff?: boolean;
    /** Already retried without append — do not loop. */
    _freshRetry?: boolean;
    onNaturalEnd?: (meta: { rolling: boolean }) => void | Promise<void>;
    onStallEnd?: () => void | Promise<void>;
  }): Promise<FfmpegJob> {
    const prev = this.startLocks.get(opts.key);
    if (prev) {
      try {
        await prev;
      } catch {
        /* previous attempt failed — try ourselves */
      }
      const existing = this.jobs.get(opts.key);
      if (existing && this.isAlive(existing) && !this.isSeekStuck(existing)) {
        existing.lastAccessAt = Date.now();
        return existing;
      }
    }

    const run = this.startHlsUnlocked(opts);
    this.startLocks.set(opts.key, run);
    try {
      return await run;
    } finally {
      if (this.startLocks.get(opts.key) === run) {
        this.startLocks.delete(opts.key);
      }
    }
  }

  private startGraceSec(): number {
    const startGraceSec = Number(
      this.config.get('STREAM_START_GRACE_SEC', 180),
    );
    return Number.isFinite(startGraceSec) && startGraceSec > 0
      ? startGraceSec
      : 180;
  }

  /** Alive but never wrote playlist past grace — safe to kill/restart. */
  private isSeekStuck(job: FfmpegJob): boolean {
    if (job.ready) return false;
    if (job.startedAt == null) return false;
    return Date.now() - job.startedAt > this.startGraceSec() * 1000;
  }

  private isAlive(job: FfmpegJob): boolean {
    return job.process.exitCode === null && !job.process.killed;
  }

  /** Public check for StreamService (reconnect after the air window limit). */
  isJobAlive(job: FfmpegJob): boolean {
    return this.isAlive(job);
  }

  /** Age of newest .ts (ms) — for /start on a stalled encode. */
  async segmentAgeMs(dir: string): Promise<number | null> {
    return this.newestSegmentAgeMs(dir);
  }

  /**
   * Kill encode marked as stall (so exit triggers onStallEnd),
   * or quietly if already dead.
   */
  requestStallSkip(key: string): boolean {
    const job = this.jobs.get(key);
    if (!job || !this.isAlive(job)) return false;
    this.rollingHandoff.add(key);
    this.stallSkip.add(key);
    this.clearHandoffTimer(key);
    job.process.kill('SIGTERM');
    return true;
  }

  private async startHlsUnlocked(opts: {
    key: string;
    streamRoot: string;
    folderName: string;
    segments: { path: string; inpointSec: number; durationSec: number }[];
    append?: boolean;
    rollingHandoff?: boolean;
    _freshRetry?: boolean;
    onNaturalEnd?: (meta: { rolling: boolean }) => void | Promise<void>;
    onStallEnd?: () => void | Promise<void>;
  }): Promise<FfmpegJob> {
    this.stopped.delete(opts.key);
    const playlist = join(opts.streamRoot, opts.folderName, 'playlist.m3u8');
    const existing = this.jobs.get(opts.key);
    if (existing) {
      if (this.isAlive(existing)) {
        try {
          await access(playlist);
          existing.lastAccessAt = Date.now();
          return existing;
        } catch {
          // Concurrent /start during seek — keep the first encode unless stuck.
          if (!this.isSeekStuck(existing)) {
            existing.lastAccessAt = Date.now();
            return existing;
          }
          this.logger.warn(
            `[${opts.key}] playlist missing after grace — restarting ffmpeg`,
          );
          this.stop(opts.key);
        }
      } else {
        this.logger.warn(`[${opts.key}] stale job in map — clearing`);
        this.jobs.delete(opts.key);
      }
    }

    const dir = join(opts.streamRoot, opts.folderName);
    // Idle wipe may still be deleting .ts — never spawn into a half-empty folder.
    await this.waitForClear(opts.key);
    await mkdir(dir, { recursive: true });
    // Synology/ACL: nginx (www) must read files created by root in the server container
    await chmod(dir, 0o755).catch(() => undefined);

    let append = !!opts.append;
    if (append && !(await this.isPlaylistAppendable(dir))) {
      this.logger.warn(
        `[${opts.key}] HLS broken — fresh start instead of append`,
      );
      append = false;
    }
    // After idle/channel switch, stale live-edge + new mid-seek =
    // a jump into the future then rollback. Append only while segments are hot.
    if (append && !(await this.isPlaylistFresh(dir))) {
      this.logger.warn(
        `[${opts.key}] HLS cold (idle/channel switch) — fresh start`,
      );
      append = false;
    }

    // Fresh: remove old m3u8/.ts, otherwise the player briefly eats the previous live-edge.
    // Append (episode seam in the same air window) — leave alone, or a gap until the first .ts.
    if (!append) {
      await this.enqueueClear(opts.key, dir);
    }

    const startNumber = append ? await this.nextStartNumber(dir) : 0;

    const firstSeg = opts.segments[0];
    // Single file + mid-seek → -ss before -i (much faster than concat inpoint on X:/NAS).
    const useFastSeek =
      opts.segments.length === 1 && (firstSeg?.inpointSec ?? 0) > 2;

    let listPath = '';
    if (!useFastSeek) {
      listPath = join(dir, 'concat.txt');
      const lines = ['ffconcat version 1.0'];
      for (const s of opts.segments) {
        const file = s.path.replace(/\\/g, '/').replace(/'/g, "'\\''");
        const inpoint = Math.max(0, s.inpointSec);
        const outpoint = inpoint + Math.max(1, s.durationSec) - 1.25;
        lines.push(`file '${file}'`);
        if (inpoint > 0) lines.push(`inpoint ${inpoint}`);
        lines.push(`outpoint ${outpoint}`);
      }
      await writeFile(listPath, lines.join('\n'), 'utf8');
    }

    const ffmpegBin = this.config.get<string>('FFMPEG_PATH', 'ffmpeg');
    const args = useFastSeek
      ? this.buildHlsArgsFastSeek(
          firstSeg.path,
          firstSeg.inpointSec,
          firstSeg.durationSec,
          playlist,
          append,
          startNumber,
        )
      : this.buildHlsArgs(listPath, playlist, append, startNumber);

    this.logger.log(
      `[${opts.key}] segs=${opts.segments.length} append=${append} start=${startNumber}` +
        `${useFastSeek ? ' fastSeek' : ''} hw=${this.hwMode()}`,
    );
    this.stop(opts.key);
    this.stopped.delete(opts.key);
    const child = spawn(ffmpegBin, args, { windowsHide: true });
    child.stderr.on('data', (buf) =>
      this.logger.warn(`[${opts.key}] ${buf.toString().trim()}`),
    );
    child.on('error', (err) => {
      this.logger.error(`[${opts.key}] spawn failed: ${err.message}`);
      this.jobs.delete(opts.key);
    });
    child.on('exit', (code, signal) => {
      const current = this.jobs.get(opts.key);
      if (current && current.process !== child) return;

      this.clearHandoffTimer(opts.key);
      this.logger.log(`[${opts.key}] ffmpeg exit code=${code} signal=${signal}`);
      const deadJob = current ?? undefined;
      this.jobs.delete(opts.key);
      const rolling = this.rollingHandoff.delete(opts.key);
      const fromStall = this.stallSkip.delete(opts.key);
      if (this.stopped.has(opts.key)) return;
      if (fromStall && opts.onStallEnd) {
        void Promise.resolve(opts.onStallEnd()).catch((e) =>
          this.logger.error(`[${opts.key}] stall restart failed: ${e}`),
        );
        return;
      }
      if (!opts.onNaturalEnd) return;
      if (code === 0 || rolling) {
        void Promise.resolve(opts.onNaturalEnd({ rolling })).catch((e) =>
          this.logger.error(`[${opts.key}] restart failed: ${e}`),
        );
        return;
      }
      // Crash — persist playhead, then rolling resume (NOT wall-clock skip).
      this.logger.warn(
        `[${opts.key}] ffmpeg died unexpectedly code=${code} signal=${signal} — resume cursor`,
      );
      void (async () => {
        if (deadJob) {
          try {
            await this.persistJobCursor(deadJob, true);
          } catch (e) {
            this.logger.warn(`[${opts.key}] crash cursor save failed: ${e}`);
          }
        }
        await Promise.resolve(opts.onNaturalEnd!({ rolling: true }));
      })().catch((e) =>
        this.logger.error(`[${opts.key}] crash restart failed: ${e}`),
      );
    });

    const job: FfmpegJob = {
      key: opts.key,
      process: child,
      dir,
      playlistUrl: `${STREAM_URL_PREFIX}/${opts.folderName}/playlist.m3u8`,
      lastAccessAt: Date.now(),
      startedAt: Date.now(),
      ready: false,
      onNaturalEnd: opts.onNaturalEnd,
    };
    this.jobs.set(opts.key, job);

    const windowSec = opts.segments.reduce((s, x) => s + x.durationSec, 0);
    const leadSec = 30;
    if (opts.rollingHandoff && opts.onNaturalEnd && windowSec > leadSec + 180) {
      const delayMs = (windowSec - leadSec) * 1000;
      const timer = setTimeout(() => {
        const current = this.jobs.get(opts.key);
        if (!current || current.process !== child) return;
        this.logger.log(
          `[${opts.key}] rolling handoff (~${leadSec}s before window end)`,
        );
        this.rollingHandoff.add(opts.key);
        child.kill('SIGTERM');
      }, delayMs);
      this.handoffTimers.set(opts.key, timer);
    } else if (
      // Mid-episode solo: ffmpeg often hangs on credits/EOF and never exits.
      // Without a timer we only recover via stall (or channel switch → /start).
      !opts.rollingHandoff &&
      opts.segments.length === 1 &&
      (opts.onStallEnd || opts.onNaturalEnd) &&
      windowSec >= 25
    ) {
      const earlySec = Math.min(
        10,
        Math.max(4, Math.floor(windowSec * 0.04)),
      );
      const delayMs = Math.max(12_000, (windowSec - earlySec) * 1000);
      const timer = setTimeout(() => {
        const current = this.jobs.get(opts.key);
        if (!current || current.process !== child) return;
        this.logger.log(
          `[${opts.key}] solo seam handoff (~${earlySec}s before window end, ${windowSec}s slot)`,
        );
        // Prefer stall-skip path → completedEpisodeIds + next slot (Time Squad → Dexter)
        if (opts.onStallEnd) {
          this.stallSkip.add(opts.key);
        } else {
          this.rollingHandoff.add(opts.key);
        }
        child.kill('SIGTERM');
      }, delayMs);
      this.handoffTimers.set(opts.key, timer);
    }

    // Append/seam — short wait. Cold (channel switch / after idle) — wait for the first .ts,
    // otherwise the client hits an empty playlist → 404 storm and false "off air".
    const quickMs = Number(this.config.get('STREAM_START_QUICK_MS', 4000));
    const coldMs = Number(this.config.get('STREAM_START_COLD_MS', 12000));
    const initialWait = append
      ? Math.max(1500, Number.isFinite(quickMs) ? quickMs : 4000)
      : Math.max(
          8000,
          Number.isFinite(coldMs) ? coldMs : 12_000,
          Number.isFinite(quickMs) ? quickMs : 4000,
        );
    try {
      await this.waitForPlaylist(playlist, child, initialWait, startNumber);
      job.ready = true;
      void this.sweepOrphanSegments(dir).catch((e) =>
        this.logger.warn(`[${opts.key}] orphan sweep failed: ${e}`),
      );
      return job;
    } catch {
      /* deferred — client must poll /status, not play the URL yet */
    }

    const seekSec = Math.max(0, firstSeg?.inpointSec ?? 0);
    const longMs = Math.min(
      300_000,
      Math.max(90_000, 45_000 + Math.ceil(seekSec) * 80),
    );
    void this.waitForPlaylist(playlist, child, longMs, startNumber)
      .then(() => {
        const cur = this.jobs.get(opts.key);
        if (cur && cur.process === child) {
          cur.ready = true;
          this.logger.log(`[${opts.key}] HLS ready (deferred)`);
        }
        void this.sweepOrphanSegments(dir).catch(() => undefined);
      })
      .catch(async (e) => {
        const cur = this.jobs.get(opts.key);
        if (!cur || cur.process !== child) return;
        this.logger.error(`[${opts.key}] deferred playlist wait failed — ${e}`);
        this.stopped.add(opts.key);
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        this.jobs.delete(opts.key);
        this.clearHandoffTimer(opts.key);
        if (append && !opts._freshRetry) {
          this.logger.warn(`[${opts.key}] retry fresh HLS after deferred fail`);
          try {
            await this.enqueueClear(opts.key, dir);
            await this.startHlsUnlocked({
              ...opts,
              append: false,
              _freshRetry: true,
            });
          } catch (err) {
            this.logger.error(`[${opts.key}] fresh retry failed: ${err}`);
          }
        }
      });

    return job;
  }

  stop(key: string) {
    this.stopped.add(key);
    this.rollingHandoff.delete(key);
    this.stallSkip.delete(key);
    this.clearHandoffTimer(key);
    const job = this.jobs.get(key);
    if (!job) return false;
    job.process.kill('SIGTERM');
    this.jobs.delete(key);
    void this.sweepOrphanSegments(job.dir).catch(() => undefined);
    return true;
  }

  listJobs(): FfmpegJob[] {
    return [...this.jobs.values()];
  }

  /** Full HLS wipe after end of air: .ts + .m3u8 + concat. */
  async clearHlsFolder(dir: string): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter(
          (n) =>
            n.endsWith('.ts') ||
            n.endsWith('.m3u8') ||
            n === 'concat.txt',
        )
        .map((n) => rm(join(dir, n), { force: true })),
    );
    this.logger.log(`[hls] cleared folder ${dir}`);
  }

  async stopAndClear(key: string): Promise<boolean> {
    const job = this.jobs.get(key);
    const dir = job?.dir;
    const stopped = this.stop(key);
    if (dir) {
      await this.enqueueClear(key, dir);
    }
    return stopped;
  }

  @Interval(15_000)
  reapIdleJobs() {
    const ttlSec = Number(
      this.config.get('STREAM_IDLE_TTL_SEC', STREAM_IDLE_TTL_SEC),
    );
    const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : STREAM_IDLE_TTL_SEC;
    const grace = this.startGraceSec();
    const cutoff = Date.now() - ttl * 1000;
    for (const [key, job] of this.jobs) {
      if (this.isAlive(job)) {
        void this.sweepOrphanSegments(job.dir).catch(() => undefined);
      }
      if (job.lastAccessAt >= cutoff) continue;
      // Cold seek on NAS often > TTL — don't wipe while first playlist is pending.
      if (!job.ready && !this.isSeekStuck(job)) {
        continue;
      }
      // Mark touched so the next 15s tick doesn't double-reap while we await disk.
      job.lastAccessAt = Date.now();
      this.logger.log(
        `[${key}] idle ${ttl}s (no viewers) — stopping ffmpeg + clear HLS`,
      );
      const dir = job.dir;
      void (async () => {
        try {
          await this.persistJobCursor(job, true);
        } catch (e) {
          this.logger.warn(`[${key}] idle cursor save failed: ${e}`);
        }
        this.stop(key);
        try {
          await this.enqueueClear(key, dir);
        } catch (e) {
          this.logger.warn(`[${key}] idle HLS clear failed: ${e}`);
        }
      })();
    }
  }

  /** Persist air cursor at encode playhead (idle kill / crash / Nest destroy). */
  async persistJobCursor(
    job: FfmpegJob,
    bumpGeneration = false,
  ): Promise<void> {
    if (!job.mediaPath || !job.episodeId || !job.durationSec) return;
    const elapsed = Math.max(
      0,
      (Date.now() - (job.startedAt ?? Date.now())) / 1000,
    );
    const inpoint = Math.floor((job.offsetSec ?? 0) + elapsed);
    const remain = Math.max(1, Math.floor(job.durationSec - elapsed));
    const { tz } = parseStreamKey(job.key);
    const prev = await readAirFinish(job.dir);
    const generation = bumpGeneration
      ? (prev?.generation ?? 0) + 1
      : (prev?.generation ?? 1);
    await writeAirFinish(job.dir, {
      date: calendarDateInTz(tz),
      episodeId: job.episodeId,
      scheduleItemId: job.scheduleItemId,
      mediaPath: job.mediaPath,
      relativePath: job.relativePath ?? '',
      inpointSec: inpoint,
      durationSec: remain,
      source: job.source ?? 'regular',
      policy: 'continuous',
      generation,
      savedAt: new Date().toISOString(),
    });
    this.logger.log(
      `[${job.key}] cursor → +${inpoint}s remain=${remain}s gen=${generation}`,
    );
  }

  /** ffmpeg is alive but .ts stop appearing (hang on EOF/credits/bad spot) → handoff + skip. */
  @Interval(10_000)
  async watchStalledEncodes() {
    const stallSec = Number(this.config.get('STREAM_STALL_SEC', 15));
    for (const [key, job] of this.jobs) {
      if (!this.isAlive(job)) continue;
      if (this.rollingHandoff.has(key)) continue;
      const ageMs = await this.newestSegmentAgeMs(job.dir);
      if (ageMs == null) continue;
      if (ageMs < stallSec * 1000) continue;
      this.logger.warn(
        `[${key}] no new .ts for ${Math.round(ageMs / 1000)}s — stall skip handoff`,
      );
      this.rollingHandoff.add(key);
      this.stallSkip.add(key);
      this.clearHandoffTimer(key);
      job.process.kill('SIGTERM');
    }
  }

  onModuleDestroy() {
    for (const key of [...this.jobs.keys()]) this.stop(key);
  }

  private async newestSegmentAgeMs(dir: string): Promise<number | null> {
    try {
      const names = await readdir(dir);
      let newest = 0;
      for (const n of names) {
        if (!/^playlist\d+\.ts$/i.test(n)) continue;
        const st = await stat(join(dir, n));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
      if (!newest) return null;
      return Date.now() - newest;
    } catch {
      return null;
    }
  }

  private clearHandoffTimer(key: string) {
    const t = this.handoffTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.handoffTimers.delete(key);
    }
  }

  private hwMode(): 'none' | 'vaapi' | 'qsv' {
    const raw = (this.config.get<string>('FFMPEG_HW', 'none') ?? 'none')
      .trim()
      .toLowerCase();
    if (raw === 'vaapi' || raw === 'qsv') return raw;
    return 'none';
  }

  /** Must appear before `-i` (VAAPI device init). */
  private hwInitArgs(): string[] {
    if (this.hwMode() !== 'vaapi') return [];
    const dev = this.config.get<string>(
      'FFMPEG_VAAPI_DEVICE',
      '/dev/dri/renderD128',
    );
    return ['-init_hw_device', `vaapi=va:${dev}`, '-filter_hw_device', 'va'];
  }

  private videoEncodeArgs(): string[] {
    const override = this.config.get<string>('FFMPEG_VIDEO_ARGS');
    if (override?.trim()) return this.parseArgs(override);

    if (this.hwMode() === 'vaapi') {
      // iGPU (Intel UHD on 8505): encode off CPU. Soft decode → hwupload → h264_vaapi.
      return this.parseArgs(
        '-vf format=nv12,hwupload -c:v h264_vaapi -b:v 4000k -maxrate 4500k -bufsize 8000k -g 48',
      );
    }
    if (this.hwMode() === 'qsv') {
      return this.parseArgs(
        '-c:v h264_qsv -preset veryfast -global_quality 21 -look_ahead 0 -b:v 4000k -maxrate 4500k -bufsize 8000k -g 48',
      );
    }
    return this.parseArgs(
      '-c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -crf 19 -maxrate 4000k -bufsize 8000k -g 48 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv',
    );
  }

  private buildHlsArgs(
    listPath: string,
    playlist: string,
    append: boolean,
    startNumber: number,
  ): string[] {
    const audioArgs = this.parseArgs(
      this.config.get<string>('FFMPEG_AUDIO_ARGS', '-c:a aac -b:a 160k'),
    );
    const listSize = String(this.config.get<number>('HLS_LIST_SIZE', 30));
    const hlsTime = String(this.config.get<number>('HLS_TIME', 2));
    // temp_file: atomic m3u8 write (no window where Nest serves 404 on the playlist).
    const flags = append
      ? 'delete_segments+omit_endlist+independent_segments+append_list+temp_file'
      : 'delete_segments+omit_endlist+independent_segments+temp_file';

    return [
      '-hide_banner',
      '-loglevel',
      'warning',
      ...this.hwInitArgs(),
      '-re',
      '-fflags',
      '+genpts',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      ...this.videoEncodeArgs(),
      ...audioArgs,
      '-avoid_negative_ts',
      'make_zero',
      '-f',
      'hls',
      '-hls_time',
      hlsTime,
      '-hls_list_size',
      listSize,
      '-hls_delete_threshold',
      '12',
      '-start_number',
      String(startNumber),
      '-hls_flags',
      flags,
      playlist,
    ];
  }

  /** Fast mid-episode seek: -ss before -i (keyframe), no concat inpoint. */
  private buildHlsArgsFastSeek(
    mediaPath: string,
    inpointSec: number,
    durationSec: number,
    playlist: string,
    append: boolean,
    startNumber: number,
  ): string[] {
    const audioArgs = this.parseArgs(
      this.config.get<string>('FFMPEG_AUDIO_ARGS', '-c:a aac -b:a 160k'),
    );
    const listSize = String(this.config.get<number>('HLS_LIST_SIZE', 30));
    const hlsTime = String(this.config.get<number>('HLS_TIME', 2));
    const flags = append
      ? 'delete_segments+omit_endlist+independent_segments+append_list+temp_file'
      : 'delete_segments+omit_endlist+independent_segments+temp_file';
    const ss = Math.max(0, inpointSec);
    const dur = Math.max(1, durationSec - 1.25);

    return [
      '-hide_banner',
      '-loglevel',
      'warning',
      ...this.hwInitArgs(),
      '-ss',
      String(ss),
      '-re',
      '-fflags',
      '+genpts',
      '-i',
      mediaPath,
      '-t',
      String(dur),
      ...this.videoEncodeArgs(),
      ...audioArgs,
      '-avoid_negative_ts',
      'make_zero',
      '-f',
      'hls',
      '-hls_time',
      hlsTime,
      '-hls_list_size',
      listSize,
      '-hls_delete_threshold',
      '12',
      '-start_number',
      String(startNumber),
      '-hls_flags',
      flags,
      playlist,
    ];
  }

  private parseArgs(raw: string): string[] {
    return raw.trim().split(/\s+/).filter(Boolean);
  }

  private async nextStartNumber(dir: string): Promise<number> {
    let max = -1;
    try {
      const names = await readdir(dir);
      for (const n of names) {
        const m = /^playlist(\d+)\.ts$/i.exec(n);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch {
      /* ignore */
    }
    // Honor sequence numbers from m3u8 — otherwise gaps after timeout: disk=4504, playlist already 4513.
    try {
      const body = await readFile(join(dir, 'playlist.m3u8'), 'utf8');
      for (const line of body.split(/\r?\n/)) {
        const m = /^playlist(\d+)\.ts$/i.exec(line.trim());
        if (m) max = Math.max(max, Number(m[1]));
        const seq = /#EXT-X-MEDIA-SEQUENCE:(\d+)/i.exec(line);
        if (seq) max = Math.max(max, Number(seq[1]) - 1);
      }
    } catch {
      /* no playlist */
    }
    return max + 1;
  }

  /**
   * Append only makes sense while HLS is "live" (episode seam / instant restart).
   * After idle/channel switch segments go cold → fresh.
   */
  async isPlaylistFresh(dir: string, maxAgeSec?: number): Promise<boolean> {
    const hlsTime = Number(this.config.get('HLS_TIME', 2));
    const listSize = Number(this.config.get('HLS_LIST_SIZE', 30));
    const defaultMax = Math.max(
      20,
      (Number.isFinite(hlsTime) ? hlsTime : 2) *
        Math.min(8, Number.isFinite(listSize) ? listSize : 30) +
        8,
    );
    const maxSec =
      maxAgeSec != null && Number.isFinite(maxAgeSec) && maxAgeSec > 0
        ? maxAgeSec
        : defaultMax;
    const ageMs = await this.newestSegmentAgeMs(dir);
    if (ageMs == null) return false;
    return ageMs <= maxSec * 1000;
  }

  /** Append only if every .ts listed in m3u8 is actually on disk. */
  async isPlaylistAppendable(dir: string): Promise<boolean> {
    return this.isPlaylistAppendableInternal(dir);
  }

  /** Append only if every .ts listed in m3u8 is actually on disk. */
  private async isPlaylistAppendableInternal(dir: string): Promise<boolean> {
    const playlistPath = join(dir, 'playlist.m3u8');
    let body: string;
    try {
      body = await readFile(playlistPath, 'utf8');
    } catch {
      return false;
    }
    const refs: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const base = t.split('/').pop()!;
      if (/\.ts$/i.test(base)) refs.push(base);
    }
    if (!refs.length) return false;
    for (const name of refs) {
      try {
        await access(join(dir, name));
      } catch {
        this.logger.warn(`[hls] missing segment ${name} — not appendable`);
        return false;
      }
    }
    return true;
  }

  private async waitForPlaylist(
    playlist: string,
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
    minSegment = 0,
  ): Promise<void> {
    const started = Date.now();
    const dir = join(playlist, '..');
    while (Date.now() - started < timeoutMs) {
      if (child.exitCode !== null) {
        throw new BadRequestException(
          `ffmpeg exited before playlist (${child.exitCode})`,
        );
      }
      try {
        await access(playlist);
        const names = await readdir(dir);
        for (const n of names) {
          const m = /^playlist(\d+)\.ts$/i.exec(n);
          if (!m || Number(m[1]) < minSegment) continue;
          try {
            const st = await stat(join(dir, n));
            // New segment from this spawn, not leftover junk.
            if (st.mtimeMs >= started - 2_000) return;
          } catch {
            /* retry */
          }
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new BadRequestException('ffmpeg playlist timeout');
  }

  private async clearHlsArtifacts(dir: string): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    // Leave playlist.m3u8 alone — otherwise hls.js hits 404 while ffmpeg writes a new one.
    await Promise.all(
      names
        .filter((n) => n.endsWith('.ts'))
        .map((n) => rm(join(dir, n), { force: true })),
    );
  }

  /**
   * Deletes playlist*.ts files that are not in the current m3u8.
   * ffmpeg delete_segments does not clean "holes" after append/restarts — leftover episode junk.
   */
  private async sweepOrphanSegments(dir: string): Promise<void> {
    const playlistPath = join(dir, 'playlist.m3u8');
    let body: string;
    try {
      body = await readFile(playlistPath, 'utf8');
    } catch {
      return;
    }

    const keep = new Set<string>();
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const base = t.split('/').pop()!;
      if (/\.ts$/i.test(base)) keep.add(base.toLowerCase());
    }
    if (!keep.size) return;

    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }

    // Skip files younger than 20s — ffmpeg may still be writing the segment.
    const freshMs = 20_000;
    const now = Date.now();
    let removed = 0;
    await Promise.all(
      names.map(async (n) => {
        if (!/^playlist\d+\.ts$/i.test(n)) return;
        if (keep.has(n.toLowerCase())) return;
        const full = join(dir, n);
        try {
          const st = await stat(full);
          if (now - st.mtimeMs < freshMs) return;
          await rm(full, { force: true });
          removed += 1;
        } catch {
          /* ignore */
        }
      }),
    );
    if (removed > 0) {
      this.logger.log(`[hls] swept ${removed} orphan .ts in ${dir}`);
    }
  }
}
