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
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';

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

  constructor(private readonly config: ConfigService) {}

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

  async startHls(opts: {
    key: string;
    streamRoot: string;
    folderName: string;
    segments: { path: string; inpointSec: number; durationSec: number }[];
    append?: boolean;
    /** false when lookahead=0 (один длинный encode — handoff только вредит). */
    rollingHandoff?: boolean;
    /** Уже был retry без append — не зацикливать. */
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
      if (existing && this.isAlive(existing)) {
        const playlist = join(
          opts.streamRoot,
          opts.folderName,
          'playlist.m3u8',
        );
        try {
          await access(playlist);
          existing.lastAccessAt = Date.now();
          return existing;
        } catch {
          /* fall through to restart */
        }
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

  private isAlive(job: FfmpegJob): boolean {
    return job.process.exitCode === null && !job.process.killed;
  }

  /** Публичная проверка для StreamService (reconnect после лимита). */
  isJobAlive(job: FfmpegJob): boolean {
    return this.isAlive(job);
  }

  /** Возраст новейшего .ts (мс) — для /start на зависшем encode. */
  async segmentAgeMs(dir: string): Promise<number | null> {
    return this.newestSegmentAgeMs(dir);
  }

  /**
   * Убить encode с пометкой stall (чтобы exit вызвал onStallEnd),
   * либо тихо если уже мёртв.
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
          this.logger.warn(`[${opts.key}] playlist missing — restarting ffmpeg`);
          this.stop(opts.key);
        }
      } else {
        this.logger.warn(`[${opts.key}] stale job in map — clearing`);
        this.jobs.delete(opts.key);
      }
    }

    const dir = join(opts.streamRoot, opts.folderName);
    await mkdir(dir, { recursive: true });

    let append = !!opts.append;
    if (append && !(await this.isPlaylistAppendable(dir))) {
      this.logger.warn(
        `[${opts.key}] HLS broken/stale — fresh start instead of append`,
      );
      append = false;
    }

    // При !append не чистим .ts заранее: иначе стык серий = пустая папка и пауза в эфире.
    // Мусор после перезаписи m3u8 подберёт sweepOrphanSegments.

    const startNumber = append ? await this.nextStartNumber(dir) : 0;

    const firstSeg = opts.segments[0];
    // Один файл + mid-seek → -ss до -i (на X:/NAS в разы быстрее concat inpoint).
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
        `${useFastSeek ? ' fastSeek' : ''}`,
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
      if (code === 0 || rolling) {
        if (!opts.onNaturalEnd) return;
        void Promise.resolve(opts.onNaturalEnd({ rolling })).catch((e) =>
          this.logger.error(`[${opts.key}] restart failed: ${e}`),
        );
      }
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
    }

    // /start не ждёт минуту: коротко пробуем, иначе starting + фон.
    const quickMs = Number(this.config.get('STREAM_START_QUICK_MS', 4000));
    try {
      await this.waitForPlaylist(
        playlist,
        child,
        Math.max(1500, quickMs),
        startNumber,
      );
      job.ready = true;
      void this.sweepOrphanSegments(dir).catch((e) =>
        this.logger.warn(`[${opts.key}] orphan sweep failed: ${e}`),
      );
      return job;
    } catch {
      /* deferred */
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
            await this.clearHlsFolder(dir);
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

  /** Полная очистка HLS после конца эфира: .ts + .m3u8 + concat. */
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
      await this.clearHlsFolder(dir);
    }
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
        void this.sweepOrphanSegments(job.dir).catch(() => undefined);
      }
      if (job.lastAccessAt >= cutoff) continue;
      this.logger.log(
        `[${key}] idle ${ttl}s (no viewers) — stopping ffmpeg`,
      );
      this.stop(key);
    }
  }

  /** ffmpeg жив, но .ts не появляются (зависон на EOF/титрах/битом месте) → handoff + skip. */
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

  private buildHlsArgs(
    listPath: string,
    playlist: string,
    append: boolean,
    startNumber: number,
  ): string[] {
    const videoArgs = this.parseArgs(
      this.config.get<string>(
        'FFMPEG_VIDEO_ARGS',
        '-c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -crf 19 -maxrate 4000k -bufsize 8000k -g 48 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv',
      ),
    );
    const audioArgs = this.parseArgs(
      this.config.get<string>('FFMPEG_AUDIO_ARGS', '-c:a aac -b:a 160k'),
    );
    const listSize = String(this.config.get<number>('HLS_LIST_SIZE', 12));
    const hlsTime = String(this.config.get<number>('HLS_TIME', 2));
    // temp_file: атомарная запись m3u8 (без окна, где Nest отдаёт 404 на playlist).
    const flags = append
      ? 'delete_segments+omit_endlist+independent_segments+append_list+temp_file'
      : 'delete_segments+omit_endlist+independent_segments+temp_file';

    return [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-re',
      '-fflags',
      '+genpts',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      ...videoArgs,
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
      '6',
      '-start_number',
      String(startNumber),
      '-hls_flags',
      flags,
      playlist,
    ];
  }

  /** Быстрый mid-episode seek: -ss до -i (ключ. кадр), без concat inpoint. */
  private buildHlsArgsFastSeek(
    mediaPath: string,
    inpointSec: number,
    durationSec: number,
    playlist: string,
    append: boolean,
    startNumber: number,
  ): string[] {
    const videoArgs = this.parseArgs(
      this.config.get<string>(
        'FFMPEG_VIDEO_ARGS',
        '-c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -crf 19 -maxrate 4000k -bufsize 8000k -g 48 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv',
      ),
    );
    const audioArgs = this.parseArgs(
      this.config.get<string>('FFMPEG_AUDIO_ARGS', '-c:a aac -b:a 160k'),
    );
    const listSize = String(this.config.get<number>('HLS_LIST_SIZE', 12));
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
      '-ss',
      String(ss),
      '-re',
      '-fflags',
      '+genpts',
      '-i',
      mediaPath,
      '-t',
      String(dur),
      ...videoArgs,
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
      '6',
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
    // Учитываем номера из m3u8 — иначе после timeout дыры: диск=4504, playlist уже 4513.
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

  /** Append только если все .ts из m3u8 реально на диске. */
  private async isPlaylistAppendable(dir: string): Promise<boolean> {
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
            // Новый сегмент этого spawn, не старый мусор.
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
    // Не трогаем playlist.m3u8 — иначе hls.js ловит 404, пока ffmpeg пишет новый.
    await Promise.all(
      names
        .filter((n) => n.endsWith('.ts'))
        .map((n) => rm(join(dir, n), { force: true })),
    );
  }

  /**
   * Удаляет playlist*.ts, которых нет в текущем m3u8.
   * ffmpeg delete_segments не чистит «дыры» после append/рестартов — оттуда мусор серий.
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

    // Не трогаем файлы младше 20с — ffmpeg мог ещё писать сегмент.
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
