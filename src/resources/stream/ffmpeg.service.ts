import { FfmpegJob } from '@app-types';
import { STREAM_IDLE_TTL_SEC, STREAM_URL_PREFIX } from '@constants';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { spawn } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class FfmpegService implements OnModuleDestroy {
  private readonly logger = new Logger(FfmpegService.name);
  private readonly jobs = new Map<string, FfmpegJob>();

  constructor(private readonly config: ConfigService) {}

  get(key: string) {
    return this.jobs.get(key);
  }

  touch(key: string) {
    const job = this.jobs.get(key);
    if (job) job.lastAccessAt = Date.now();
  }

  async startHls(opts: {
    key: string;
    streamRoot: string;
    folderName: string;
    segments: { path: string; inpointSec: number; durationSec: number }[];
  }): Promise<FfmpegJob> {
    const existing = this.jobs.get(opts.key);
    if (existing) {
      existing.lastAccessAt = Date.now();
      return existing;
    }

    const dir = join(opts.streamRoot, opts.folderName);
    await mkdir(dir, { recursive: true });

    const listPath = join(dir, 'concat.txt');
    const lines = ['ffconcat version 1.0'];
    for (const s of opts.segments) {
      const file = s.path.replace(/\\/g, '/').replace(/'/g, "'\\''");
      const inpoint = s.inpointSec;
      const outpoint = s.inpointSec + s.durationSec;
      lines.push(`file '${file}'`);
      lines.push(`inpoint ${inpoint}`);
      lines.push(`outpoint ${outpoint}`);
    }
    await writeFile(listPath, lines.join('\n'), 'utf8');

    const playlist = join(dir, 'playlist.m3u8');
    const ffmpegBin = this.config.get<string>('FFMPEG_PATH', 'ffmpeg');
    const args = this.buildHlsArgs(listPath, playlist);

    this.logger.log(
      `[${opts.key}] ${ffmpegBin} ${args.join(' ').slice(0, 200)}…`,
    );
    const child = spawn(ffmpegBin, args, { windowsHide: true });
    child.stderr.on('data', (buf) =>
      this.logger.warn(`[${opts.key}] ${buf.toString().trim()}`),
    );
    child.on('exit', (code) => {
      this.logger.log(`[${opts.key}] ffmpeg exit ${code}`);
      this.jobs.delete(opts.key);
    });

    const job: FfmpegJob = {
      key: opts.key,
      process: child,
      dir,
      playlistUrl: `${STREAM_URL_PREFIX}/${opts.folderName}/playlist.m3u8`,
      lastAccessAt: Date.now(),
    };
    this.jobs.set(opts.key, job);
    return job;
  }

  stop(key: string) {
    const job = this.jobs.get(key);
    if (!job) return false;
    job.process.kill('SIGTERM');
    this.jobs.delete(key);
    return true;
  }

  /** Drop encodes nobody requested recently. */
  @Interval(60_000)
  reapIdleJobs() {
    const ttlSec = this.config.get<number>(
      'STREAM_IDLE_TTL_SEC',
      STREAM_IDLE_TTL_SEC,
    );
    const cutoff = Date.now() - ttlSec * 1000;
    for (const [key, job] of this.jobs) {
      if (job.lastAccessAt < cutoff) {
        this.logger.log(`[${key}] idle TTL — stopping`);
        this.stop(key);
      }
    }
  }

  onModuleDestroy() {
    for (const key of [...this.jobs.keys()]) this.stop(key);
  }

  /**
   * Encode flags from env so laptop (libx264) and NAS (QSV) differ
   * without code changes.
   *
   * Laptop:  FFMPEG_VIDEO_ARGS=-c:v libx264 -preset veryfast -b:v 1500k
   * NAS:     FFMPEG_VIDEO_ARGS=-hwaccel qsv -c:v h264_qsv -b:v 1500k
   */
  private buildHlsArgs(listPath: string, playlist: string): string[] {
    const videoArgs = this.parseArgs(
      this.config.get<string>(
        'FFMPEG_VIDEO_ARGS',
        '-c:v libx264 -preset veryfast -b:v 1500k',
      ),
    );
    const audioArgs = this.parseArgs(
      this.config.get<string>('FFMPEG_AUDIO_ARGS', '-c:a aac -b:a 128k'),
    );

    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-reset_timestamps',
      '1',
      '-i',
      listPath,
      ...videoArgs,
      ...audioArgs,
      '-avoid_negative_ts',
      'make_zero',
      '-f',
      'hls',
      '-hls_time',
      '6',
      '-hls_list_size',
      '10',
      '-hls_flags',
      'delete_segments',
      playlist,
    ];
  }

  private parseArgs(raw: string): string[] {
    return raw
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }
}
