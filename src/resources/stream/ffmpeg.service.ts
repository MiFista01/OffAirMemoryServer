import { FfmpegJob } from '@app-types';
import { STREAM_IDLE_TTL_SEC } from '@constants';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { join } from 'path';
import { writeAirFinish, readAirFinish } from './air-finish.state';
import { calendarDateInTz, parseStreamKey } from './stream-air.util';
import {
  clearHlsFolder as clearHlsFolderFs,
  isPlaylistAppendable as isPlaylistAppendableFs,
  isPlaylistFresh as isPlaylistFreshFs,
  newestSegmentAgeMs,
  sweepOrphanSegments,
} from './ffmpeg-playlist';
import { startHlsUnlocked, type FfmpegStartHost } from './ffmpeg-start-hls';

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
  /**
   * Folder names mid stop→clear→spawn (no job.ready yet).
   * Static /stream must 503 here — bare 404 makes the client reboot-storm.
   */
  private readonly preparingFolders = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  markPreparing(folderName: string): void {
    if (folderName) this.preparingFolders.add(folderName);
  }

  clearPreparing(folderName: string): void {
    if (folderName) this.preparingFolders.delete(folderName);
  }

  async writeFileRetry(path: string, body: string): Promise<void> {
    const { writeFile } = await import('fs/promises');
    for (let i = 0; i < 6; i++) {
      try {
        await writeFile(path, body, 'utf8');
        return;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        const busy =
          err?.code === 'EBUSY' ||
          err?.code === 'EPERM' ||
          err?.code === 'EACCES';
        if (!busy || i === 5) throw e;
        await new Promise((r) => setTimeout(r, 80 + i * 120));
      }
    }
  }

  /** Wait for any in-flight wipe on this key (call before writing new HLS). */
  async waitForClear(key: string): Promise<void> {
    const pending = this.clearLocks.get(key);
    if (pending) await pending.catch(() => undefined);
  }

  enqueueClear(key: string, dir: string): Promise<void> {
    const prev = this.clearLocks.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.clearHlsFolder(dir);
        } catch (e) {
          // Must never reject — unhandled EBUSY used to kill the whole Nest process.
          this.logger.warn(`[${key}] HLS clear failed: ${e}`);
        }
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
    if (this.preparingFolders.has(folderName)) return true;
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

    const run = startHlsUnlocked(this as unknown as FfmpegStartHost, opts);
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
  isSeekStuck(job: FfmpegJob): boolean {
    if (job.ready) return false;
    if (job.startedAt == null) return false;
    return Date.now() - job.startedAt > this.startGraceSec() * 1000;
  }

  isAlive(job: FfmpegJob): boolean {
    return job.process.exitCode === null && !job.process.killed;
  }

  /** Public check for StreamService (reconnect after the air window limit). */
  isJobAlive(job: FfmpegJob): boolean {
    return this.isAlive(job);
  }

  /** Age of newest .ts (ms) — for /start on a stalled encode. */
  async segmentAgeMs(dir: string): Promise<number | null> {
    return newestSegmentAgeMs(dir);
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


  stop(key: string) {
    this.stopped.add(key);
    this.rollingHandoff.delete(key);
    this.stallSkip.delete(key);
    this.clearHandoffTimer(key);
    const job = this.jobs.get(key);
    if (!job) return false;
    job.process.kill('SIGTERM');
    this.jobs.delete(key);
    // Do NOT sweep orphans here — races with append restart writing new .ts.
    return true;
  }

  listJobs(): FfmpegJob[] {
    return [...this.jobs.values()];
  }

  async clearHlsFolder(dir: string): Promise<void> {
    return clearHlsFolderFs(this.logger, dir);
  }

  async isPlaylistFresh(dir: string, maxAgeSec?: number): Promise<boolean> {
    return isPlaylistFreshFs(this.config, dir, maxAgeSec);
  }

  async isPlaylistAppendable(dir: string): Promise<boolean> {
    return isPlaylistAppendableFs(this.logger, dir);
  }

  async stopAndClear(key: string): Promise<boolean> {
    const job = this.jobs.get(key);
    const dir = job?.dir;
    const folder = dir?.replace(/\\/g, '/').split('/').pop();
    if (folder) this.markPreparing(folder);
    const stopped = this.stop(key);
    if (dir) {
      // Let Windows release concat.txt handles before unlink.
      await new Promise((r) => setTimeout(r, 200));
      await this.enqueueClear(key, dir);
    }
    if (folder) this.clearPreparing(folder);
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
        void sweepOrphanSegments(this.logger, job.dir).catch(() => undefined);
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
          await new Promise((r) => setTimeout(r, 200));
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
      const ageMs = await newestSegmentAgeMs(job.dir);
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

  clearHandoffTimer(key: string) {
    const t = this.handoffTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.handoffTimers.delete(key);
    }
  }
}
