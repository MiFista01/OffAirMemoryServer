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
import {
  otherSlot,
  streamChannelKey,
  streamJobKey,
  type StreamSlot,
} from './stream-slot.util';

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
  /** Active HLS slot per channel (`slug:tz:profile` → a|b). */
  private readonly activeSlots = new Map<string, StreamSlot>();
  /** Standby slot currently warming (if any). */
  private readonly standbySlots = new Map<string, StreamSlot>();
  private readonly retireTimers = new Map<string, NodeJS.Timeout>();

  /** Serialize folder wipes so /start cannot spawn into a half-deleted HLS dir. */
  private readonly clearLocks = new Map<string, Promise<void>>();
  /**
   * Folder names mid stop→clear→spawn (no job.ready yet).
   * Static /stream must 503 here — bare 404 makes the client reboot-storm.
   * May be `channelFolder` or `channelFolder/a`.
   */
  private readonly preparingFolders = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  getActiveSlot(channelKey: string): StreamSlot {
    return this.activeSlots.get(channelKey) ?? 'a';
  }

  setActiveSlot(channelKey: string, slot: StreamSlot): void {
    this.activeSlots.set(channelKey, slot);
  }

  getStandbySlot(channelKey: string): StreamSlot | undefined {
    return this.standbySlots.get(channelKey);
  }

  setStandbySlot(channelKey: string, slot: StreamSlot | undefined): void {
    if (slot) this.standbySlots.set(channelKey, slot);
    else this.standbySlots.delete(channelKey);
  }

  /** Resolve active encode for channel key without slot suffix. */
  getActive(channelKey: string): FfmpegJob | undefined {
    const legacy = this.jobs.get(channelKey);
    if (legacy && this.isAlive(legacy)) return legacy;
    const slot = this.getActiveSlot(channelKey);
    const { slug, tz, profile } = parseStreamKey(channelKey);
    return this.jobs.get(streamJobKey(slug, tz, profile, slot));
  }

  getBySlot(channelKey: string, slot: StreamSlot): FfmpegJob | undefined {
    const { slug, tz, profile } = parseStreamKey(channelKey);
    return this.jobs.get(streamJobKey(slug, tz, profile, slot));
  }

  /** Stop both slots + clear active/standby bookkeeping. */
  stopChannel(channelKey: string): void {
    const t = this.retireTimers.get(channelKey);
    if (t) clearTimeout(t);
    this.retireTimers.delete(channelKey);
    this.standbySlots.delete(channelKey);
    this.activeSlots.delete(channelKey);
    const { slug, tz, profile } = parseStreamKey(channelKey);
    for (const slot of ['a', 'b'] as StreamSlot[]) {
      this.stop(streamJobKey(slug, tz, profile, slot));
    }
    // Legacy key (pre-slot)
    this.stop(channelKey);
  }

  /** Keep idle TTL alive for active + warming standby (same viewer). */
  touchChannel(channelKey: string): void {
    const active = this.getActive(channelKey);
    if (active) active.lastAccessAt = Date.now();
    const sb = this.getStandbySlot(channelKey);
    if (!sb) return;
    const standbyJob = this.getBySlot(channelKey, sb);
    if (standbyJob) standbyJob.lastAccessAt = Date.now();
  }

  /** Absolute HLS dir for the active slot (or legacy channel root). */
  activeHlsDir(streamRoot: string, channelFolder: string, channelKey: string): string {
    const job = this.getActive(channelKey);
    const slot = job?.slot ?? this.getActiveSlot(channelKey);
    if (job?.dir) return job.dir;
    return join(streamRoot, channelFolder, slot);
  }

  /**
   * After promote: kill old encode immediately and remove playlist so a stray
   * client poll cannot briefly replay the previous show's credits (X-Men under Kim).
   * Full .ts wipe follows after a short delay (file handles / Windows EBUSY).
   */
  scheduleRetireSlot(
    channelKey: string,
    slot: StreamSlot,
    delayMs: number,
  ): void {
    const prev = this.retireTimers.get(channelKey);
    if (prev) clearTimeout(prev);
    const { slug, tz, profile } = parseStreamKey(channelKey);
    const jobKey = streamJobKey(slug, tz, profile, slot);
    const job = this.getBySlot(channelKey, slot);
    const dir = job?.dir;
    // Stop writing immediately — do not leave old ffmpeg updating m3u8 for 45s.
    this.stop(jobKey);
    if (dir) {
      void (async () => {
        try {
          const { unlink } = await import('fs/promises');
          await unlink(join(dir, 'playlist.m3u8')).catch(() => undefined);
          this.logger.log(
            `[${channelKey}] retire slot=${slot} — stopped + playlist removed`,
          );
        } catch {
          /* ignore */
        }
      })();
    }
    const wipeDelay = Math.min(Math.max(delayMs, 3_000), 12_000);
    const timer = setTimeout(() => {
      this.retireTimers.delete(channelKey);
      this.logger.log(`[${channelKey}] retire slot=${slot} — wipe`);
      void this.stopAndClear(jobKey).catch((e) =>
        this.logger.warn(`[${channelKey}] retire slot=${slot} failed: ${e}`),
      );
    }, wipeDelay);
    this.retireTimers.set(channelKey, timer);
  }

  nextStandbySlot(channelKey: string): StreamSlot {
    return otherSlot(this.getActiveSlot(channelKey));
  }

  channelKeyOf(slug: string, tz: string, profile: string): string {
    return streamChannelKey(slug, tz, profile);
  }

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
    // Prefer exact key; if channel key without slot — resolve active.
    const exact = this.jobs.get(key);
    if (exact) return exact;
    if (/:(a|b)$/.test(key)) return undefined;
    return this.getActive(key);
  }

  touch(key: string) {
    const job = this.get(key);
    if (job) job.lastAccessAt = Date.now();
  }

  /** Touch by HLS folder name — channel root or `channel/a`. */
  touchByFolder(folderName: string): boolean {
    if (!folderName) return false;
    let touched = false;
    for (const job of this.jobs.values()) {
      const dir = job.dir.replace(/\\/g, '/');
      const url = job.playlistUrl;
      if (
        dir.endsWith(`/${folderName}`) ||
        dir.includes(`/${folderName}/`) ||
        dir.endsWith(folderName) ||
        url.includes(`/${folderName}/`)
      ) {
        job.lastAccessAt = Date.now();
        touched = true;
      }
    }
    return touched;
  }

  /**
   * Encode is already running, but the playlist is not ready yet (seek).
   * Static middleware answers 503 instead of 404 — so hls.js does not get a Not Found storm.
   */
  isFolderPreparing(folderName: string): boolean {
    if (!folderName) return false;
    if (this.preparingFolders.has(folderName)) return true;
    // Nested slot: preparing marked as `channel/a`
    for (const p of this.preparingFolders) {
      if (p === folderName || p.startsWith(`${folderName}/`)) return true;
    }
    for (const job of this.jobs.values()) {
      if (!this.isAlive(job) || job.ready) continue;
      const dir = job.dir.replace(/\\/g, '/');
      if (
        dir.endsWith(`/${folderName}`) ||
        dir.includes(`/${folderName}/`) ||
        dir.endsWith(folderName) ||
        job.playlistUrl.includes(`/${folderName}/`)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Preparing for the ACTIVE slot only.
   * Standby cold-seek must NOT make socket/seam report a connect chyron
   * while the live slot is still playing.
   */
  isActiveSlotPreparing(channelKey: string, channelFolder: string): boolean {
    if (!channelFolder) return false;
    const slot = this.getActiveSlot(channelKey);
    const activeFolder = `${channelFolder}/${slot}`;
    if (this.preparingFolders.has(activeFolder)) return true;
    if (this.preparingFolders.has(channelFolder)) return true;
    const job = this.getActive(channelKey);
    return !!(job && this.isAlive(job) && !job.ready);
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
    /** Dual-slot: spawn next encode in the other slot ~bridgeSec before EOF (no kill). */
    onStandbyPrep?: () => void | Promise<void>;
    slot?: 'a' | 'b';
    channelKey?: string;
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
    const job = this.jobs.get(key) ?? this.getActive(key);
    if (!job || !this.isAlive(job)) return false;
    const jobKey = job.key;
    this.rollingHandoff.add(jobKey);
    this.stallSkip.add(jobKey);
    this.clearHandoffTimer(jobKey);
    job.process.kill('SIGTERM');
    return true;
  }


  stop(key: string) {
    const job = this.jobs.get(key) ?? (!/:(a|b)$/.test(key) ? this.getActive(key) : undefined);
    const jobKey = job?.key ?? key;
    this.stopped.add(jobKey);
    this.rollingHandoff.delete(jobKey);
    this.stallSkip.delete(jobKey);
    this.clearHandoffTimer(jobKey);
    if (!job) return false;
    job.process.kill('SIGTERM');
    this.jobs.delete(jobKey);
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
    // Dual-slot: preparing key is `channelFolder/a` (not just `a`).
    const norm = dir?.replace(/\\/g, '/') ?? '';
    const folder =
      /\/([^/]+\/[ab])$/.exec(norm)?.[1] ?? norm.split('/').pop();
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

      // Dual-slot: never reap standby while active is still watched.
      const channelKey =
        job.channelKey ??
        (job.key.endsWith(':a') || job.key.endsWith(':b')
          ? job.key.slice(0, -2)
          : job.key);
      const standbySlot = this.getStandbySlot(channelKey);
      if (standbySlot && job.slot === standbySlot) {
        const active = this.getActive(channelKey);
        if (active && this.isAlive(active) && active.lastAccessAt >= cutoff) {
          job.lastAccessAt = Date.now();
          continue;
        }
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
    // Standby must not clobber the active episode's air-finish cursor.
    if (job.channelKey && job.slot) {
      const sb = this.getStandbySlot(job.channelKey);
      if (sb === job.slot) {
        this.logger.log(
          `[${job.key}] skip cursor persist — standby slot (active still on air)`,
        );
        return;
      }
    }
    const elapsed = Math.max(
      0,
      (Date.now() - (job.startedAt ?? Date.now())) / 1000,
    );
    const inpoint = Math.floor((job.offsetSec ?? 0) + elapsed);
    const remain = Math.max(1, Math.floor(job.durationSec - elapsed));
    // Don't persist a credits stub — next /start would loop the ending.
    if (remain <= 45) {
      this.logger.log(
        `[${job.key}] skip cursor persist (only ${remain}s left — treat as done)`,
      );
      return;
    }
    const { tz } = parseStreamKey(job.key);
    // Dual-slot: HLS is in …/a|b — air-finish stays on the channel root.
    const cursorDir = /[/\\][ab]$/.test(job.dir.replace(/\\/g, '/'))
      ? job.dir.replace(/[/\\][ab]$/, '')
      : job.dir;
    const prev = await readAirFinish(cursorDir);
    const generation = bumpGeneration
      ? (prev?.generation ?? 0) + 1
      : (prev?.generation ?? 1);
    await writeAirFinish(cursorDir, {
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
      // Never stall-kill a warming standby — cold seek has long gaps with no new .ts.
      const channelKey =
        job.channelKey ??
        (job.key.endsWith(':a') || job.key.endsWith(':b')
          ? job.key.slice(0, -2)
          : job.key);
      const standbySlot = this.getStandbySlot(channelKey);
      if (standbySlot && job.slot === standbySlot) continue;
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
