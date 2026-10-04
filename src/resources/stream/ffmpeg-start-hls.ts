import { FfmpegJob } from '@app-types';
import { STREAM_URL_PREFIX } from '@constants';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { access, chmod, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  buildHlsArgs,
  buildHlsArgsFastSeek,
  hwMode,
} from './ffmpeg-hls-args';
import {
  nextStartNumber,
  sweepOrphanSegments,
  waitForPlaylist,
} from './ffmpeg-playlist';

export type FfmpegStartHost = {
  logger: Logger;
  config: ConfigService;
  jobs: Map<string, FfmpegJob>;
  stopped: Set<string>;
  rollingHandoff: Set<string>;
  stallSkip: Set<string>;
  handoffTimers: Map<string, NodeJS.Timeout>;
  waitForClear(key: string): Promise<void>;
  isAlive(job: FfmpegJob): boolean;
  isSeekStuck(job: FfmpegJob): boolean;
  stop(key: string): boolean;
  isPlaylistAppendable(dir: string): Promise<boolean>;
  isPlaylistFresh(dir: string, maxAgeSec?: number): Promise<boolean>;
  enqueueClear(key: string, dir: string): Promise<void>;
  clearHandoffTimer(key: string): void;
  persistJobCursor(job: FfmpegJob, bumpGeneration?: boolean): Promise<void>;
  markPreparing(folderName: string): void;
  clearPreparing(folderName: string): void;
  writeFileRetry(path: string, body: string): Promise<void>;
};

export async function startHlsUnlocked(
  host: FfmpegStartHost,
  opts: {
    key: string;
    streamRoot: string;
    folderName: string;
    segments: { path: string; inpointSec: number; durationSec: number }[];
    append?: boolean;
    rollingHandoff?: boolean;
    _freshRetry?: boolean;
    onNaturalEnd?: (meta: { rolling: boolean }) => void | Promise<void>;
    onStallEnd?: () => void | Promise<void>;
    /** Dual-slot: prep next cartoon without killing this encode. */
    onStandbyPrep?: () => void | Promise<void>;
    slot?: 'a' | 'b';
    channelKey?: string;
  }): Promise<FfmpegJob> {
    host.stopped.delete(opts.key);
    const playlist = join(opts.streamRoot, opts.folderName, 'playlist.m3u8');
    const existing = host.jobs.get(opts.key);
    if (existing) {
      if (host.isAlive(existing)) {
        try {
          await access(playlist);
          existing.lastAccessAt = Date.now();
          return existing;
        } catch {
          // Concurrent /start during seek — keep the first encode unless stuck.
          if (!host.isSeekStuck(existing)) {
            existing.lastAccessAt = Date.now();
            return existing;
          }
          host.logger.warn(
            `[${opts.key}] playlist missing after grace — restarting ffmpeg`,
          );
          host.stop(opts.key);
        }
      } else {
        host.logger.warn(`[${opts.key}] stale job in map — clearing`);
        host.jobs.delete(opts.key);
      }
    }

    const dir = join(opts.streamRoot, opts.folderName);
    // Idle wipe may still be deleting .ts — never spawn into a half-empty folder.
    await host.waitForClear(opts.key);
    await mkdir(dir, { recursive: true });
    // Synology/ACL: nginx (www) must read files created by root in the server container
    await chmod(dir, 0o755).catch(() => undefined);

    let append = !!opts.append;
    if (append && !(await host.isPlaylistAppendable(dir))) {
      host.logger.warn(
        `[${opts.key}] HLS broken — fresh start instead of append`,
      );
      append = false;
    }
    // Do NOT drop append just because .ts stopped updating (ffmpeg was killed for
    // rolling/bridge). That wiped playlist.m3u8 → nginx 503 mid-watch.
    // Idle/cold callers already pass append=false when isPlaylistFresh is false.

    // Kill previous ffmpeg FIRST — otherwise Windows EBUSY on concat.txt/.ts wipe.
    host.stop(opts.key);
    // Only block static /stream when we wipe the folder. Append keeps playlist.m3u8
    // playable so the TV buffer does not go black during the seam.
    if (!append) host.markPreparing(opts.folderName);
    let child: ReturnType<typeof spawn>;
    let startNumber: number;
    let firstSeg: (typeof opts.segments)[0];
    let useFastSeek: boolean;
    try {
      if (!append) {
        await new Promise((r) => setTimeout(r, 200));
        await host.enqueueClear(opts.key, dir);
      }

      startNumber = append ? await nextStartNumber(dir) : 0;

      firstSeg = opts.segments[0];
      // Single file + mid-seek → -ss before -i (much faster than concat inpoint on X:/NAS).
      useFastSeek =
        opts.segments.length === 1 && (firstSeg?.inpointSec ?? 0) > 2;

      let listPath = '';
      if (!useFastSeek) {
        listPath = join(dir, 'concat.txt');
        const lines = ['ffconcat version 1.0'];
        for (const s of opts.segments) {
          const file = s.path.replace(/\\/g, '/').replace(/'/g, "'\\''");
          const inpoint = Math.max(0, s.inpointSec);
          const outpoint = inpoint + Math.max(1, s.durationSec) - 0.05;
          lines.push(`file '${file}'`);
          if (inpoint > 0) lines.push(`inpoint ${inpoint}`);
          lines.push(`outpoint ${outpoint}`);
        }
        await host.writeFileRetry(listPath, lines.join('\n'));
      }

      const ffmpegBin = host.config.get<string>('FFMPEG_PATH', 'ffmpeg');
      const args = useFastSeek
        ? buildHlsArgsFastSeek(
            host.config,
            firstSeg.path,
            firstSeg.inpointSec,
            firstSeg.durationSec,
            playlist,
            append,
            startNumber,
          )
        : buildHlsArgs(host.config, listPath, playlist, append, startNumber);

      host.logger.log(
        `[${opts.key}] segs=${opts.segments.length} append=${append} start=${startNumber}` +
          `${useFastSeek ? ' fastSeek' : ''} hw=${hwMode(host.config)}`,
      );
      host.stopped.delete(opts.key);
      child = spawn(ffmpegBin, args, { windowsHide: true });
    } catch (e) {
      host.clearPreparing(opts.folderName);
      throw e;
    }
    child.stderr.on('data', (buf) =>
      host.logger.warn(`[${opts.key}] ${buf.toString().trim()}`),
    );
    child.on('error', (err) => {
      host.logger.error(`[${opts.key}] spawn failed: ${err.message}`);
      host.jobs.delete(opts.key);
      host.clearPreparing(opts.folderName);
    });
    child.on('exit', (code, signal) => {
      const current = host.jobs.get(opts.key);
      // Late exit after stop()/superseded spawn — do NOT continueEncode (ending loops).
      if (!current || current.process !== child) return;

      host.clearHandoffTimer(opts.key);
      host.clearPreparing(opts.folderName);
      host.logger.log(`[${opts.key}] ffmpeg exit code=${code} signal=${signal}`);
      const deadJob = current;
      host.jobs.delete(opts.key);
      const rolling = host.rollingHandoff.delete(opts.key);
      const fromStall = host.stallSkip.delete(opts.key);
      if (host.stopped.has(opts.key)) return;
      if (fromStall && opts.onStallEnd) {
        void Promise.resolve(opts.onStallEnd()).catch((e) =>
          host.logger.error(`[${opts.key}] stall restart failed: ${e}`),
        );
        return;
      }
      if (!opts.onNaturalEnd) return;
      if (code === 0 || rolling) {
        void Promise.resolve(opts.onNaturalEnd({ rolling })).catch((e) =>
          host.logger.error(`[${opts.key}] restart failed: ${e}`),
        );
        return;
      }
      // Crash — persist playhead, then rolling resume (NOT wall-clock skip).
      host.logger.warn(
        `[${opts.key}] ffmpeg died unexpectedly code=${code} signal=${signal} — resume cursor`,
      );
      void (async () => {
        try {
          await host.persistJobCursor(deadJob, true);
        } catch (e) {
          host.logger.warn(`[${opts.key}] crash cursor save failed: ${e}`);
        }
        await Promise.resolve(opts.onNaturalEnd!({ rolling: true }));
      })().catch((e) =>
        host.logger.error(`[${opts.key}] crash restart failed: ${e}`),
      );
    });

    const windowSec = opts.segments.reduce((s, x) => s + x.durationSec, 0);
    const job: FfmpegJob = {
      key: opts.key,
      process: child,
      dir,
      playlistUrl: `${STREAM_URL_PREFIX}/${opts.folderName}/playlist.m3u8`,
      lastAccessAt: Date.now(),
      startedAt: Date.now(),
      ready: false,
      onNaturalEnd: opts.onNaturalEnd,
      encodeWindowSec: windowSec,
      segmentCount: opts.segments.length,
      slot: opts.slot,
      channelKey: opts.channelKey,
    };
    host.jobs.set(opts.key, job);

    const leadSec = 30;

    const armRollingKill = (label: string, delayMs: number) => {
      const timer = setTimeout(() => {
        void (async () => {
          const current = host.jobs.get(opts.key);
          if (!current || current.process !== child) return;
          try {
            // Keep playhead so resume appends — never wipe mid-seam.
            await host.persistJobCursor(current, false);
          } catch (e) {
            host.logger.warn(`[${opts.key}] handoff cursor save failed: ${e}`);
          }
          host.logger.log(`[${opts.key}] ${label}`);
          host.rollingHandoff.add(opts.key);
          child.kill('SIGTERM');
        })();
      }, delayMs);
      host.handoffTimers.set(opts.key, timer);
    };

    if (opts.rollingHandoff && opts.onNaturalEnd && windowSec > leadSec + 180) {
      armRollingKill(
        `rolling handoff (~${leadSec}s before window end)`,
        (windowSec - leadSec) * 1000,
      );
    } else if (
      // Mid-episode solo: ffmpeg often hangs on credits/EOF and never exits.
      // Without a timer we only recover via stall (or channel switch → /start).
      !opts.rollingHandoff &&
      opts.segments.length === 1 &&
      (opts.onStallEnd || opts.onNaturalEnd || opts.onStandbyPrep) &&
      windowSec >= 25
    ) {
      const bridgeCfg = Number(host.config.get('STREAM_SEAM_BRIDGE_SEC', 180));
      const bridgeSec =
        Number.isFinite(bridgeCfg) && bridgeCfg > 0 ? bridgeCfg : 180;
      // Dual-slot: spawn standby in the other folder before EOF —
      // do NOT kill this encode (client keeps playing until switch).
      // Short episodes (< bridge+45): still prep standby with a shorter lead.
      if (opts.onStandbyPrep && windowSec >= 40) {
        // Longer lead so standby is warm before EOF (invisible seam).
        // Client dual-slot attach uses startPosition:0 — safe even if standby
        // has been encoding for ~45–60s (no live-edge intro skip).
        const prepLead = Math.min(
          55,
          Math.max(35, Math.floor(windowSec * 0.12)),
        );
        const delayMs = Math.max(8_000, (windowSec - prepLead) * 1000);
        const timer = setTimeout(() => {
          const current = host.jobs.get(opts.key);
          if (!current || current.process !== child) return;
          host.logger.log(
            `[${opts.key}] dual-slot standby prep (~${prepLead}s lead of ${Math.round(windowSec)}s)`,
          );
          void Promise.resolve(opts.onStandbyPrep!()).catch((e) =>
            host.logger.warn(`[${opts.key}] standby prep failed: ${e}`),
          );
        }, delayMs);
        host.handoffTimers.set(opts.key, timer);
      } else if (opts.onStandbyPrep && windowSec >= 25) {
        // Very short: start standby ASAP so next is ready near EOF.
        const delayMs = Math.max(5_000, Math.floor(windowSec * 0.4) * 1000);
        const timer = setTimeout(() => {
          const current = host.jobs.get(opts.key);
          if (!current || current.process !== child) return;
          host.logger.log(
            `[${opts.key}] dual-slot standby prep (short ${Math.round(windowSec)}s)`,
          );
          void Promise.resolve(opts.onStandbyPrep!()).catch((e) =>
            host.logger.warn(`[${opts.key}] standby prep failed: ${e}`),
          );
        }, delayMs);
        host.handoffTimers.set(opts.key, timer);
      } else if (opts.onNaturalEnd && windowSec > bridgeSec + 45 && !opts.onStandbyPrep) {
        // Legacy concat bridge path (disabled when onStandbyPrep is set).
        armRollingKill(
          `solo→bridge handoff (~${bridgeSec}s left of ${Math.round(windowSec)}s)`,
          Math.max(15_000, (windowSec - bridgeSec) * 1000),
        );
      } else {
        const earlySec = Math.min(
          10,
          Math.max(4, Math.floor(windowSec * 0.04)),
        );
        const delayMs = Math.max(12_000, (windowSec - earlySec) * 1000);
        const timer = setTimeout(() => {
          const current = host.jobs.get(opts.key);
          if (!current || current.process !== child) return;
          host.logger.log(
            `[${opts.key}] solo seam handoff (~${earlySec}s before window end, ${windowSec}s slot)`,
          );
          // Prefer stall-skip path → completedEpisodeIds + next slot (Time Squad → Dexter)
          if (opts.onStallEnd) {
            host.stallSkip.add(opts.key);
          } else {
            host.rollingHandoff.add(opts.key);
          }
          child.kill('SIGTERM');
        }, delayMs);
        host.handoffTimers.set(opts.key, timer);
      }
    }

    // Append/seam — short wait. Cold (channel switch / after idle) — wait for the first .ts,
    // otherwise the client hits an empty playlist → 404 storm and false "off air".
    const quickMs = Number(host.config.get('STREAM_START_QUICK_MS', 4000));
    const coldMs = Number(host.config.get('STREAM_START_COLD_MS', 12000));
    const initialWait = append
      ? Math.max(1500, Number.isFinite(quickMs) ? quickMs : 4000)
      : Math.max(
          8000,
          Number.isFinite(coldMs) ? coldMs : 12_000,
          Number.isFinite(quickMs) ? quickMs : 4000,
        );
    try {
      await waitForPlaylist(playlist, child, initialWait, startNumber);
      job.ready = true;
      host.clearPreparing(opts.folderName);
      void sweepOrphanSegments(host.logger, dir).catch((e) =>
        host.logger.warn(`[${opts.key}] orphan sweep failed: ${e}`),
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
    void waitForPlaylist(playlist, child, longMs, startNumber)
      .then(() => {
        const cur = host.jobs.get(opts.key);
        if (cur && cur.process === child) {
          cur.ready = true;
          host.clearPreparing(opts.folderName);
          host.logger.log(`[${opts.key}] HLS ready (deferred)`);
        }
        void sweepOrphanSegments(host.logger, dir).catch(() => undefined);
      })
      .catch(async (e) => {
        const cur = host.jobs.get(opts.key);
        if (!cur || cur.process !== child) return;
        host.logger.error(`[${opts.key}] deferred playlist wait failed — ${e}`);
        host.stopped.add(opts.key);
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        host.jobs.delete(opts.key);
        host.clearHandoffTimer(opts.key);
        host.clearPreparing(opts.folderName);
        if (append && !opts._freshRetry) {
          host.logger.warn(`[${opts.key}] retry fresh HLS after deferred fail`);
          try {
            await host.enqueueClear(opts.key, dir);
            await startHlsUnlocked(host, {
              ...opts,
              append: false,
              _freshRetry: true,
            });
          } catch (err) {
            host.logger.error(`[${opts.key}] fresh retry failed: ${err}`);
          }
        }
      });

    return job;
  }
