import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { access, readdir, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';

/** Windows: ffmpeg often still holds concat.txt/.ts after SIGTERM → EBUSY. */
async function safeRm(
  logger: Logger | undefined,
  path: string,
  tries = 6,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await rm(path, { force: true });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const busy =
        err?.code === 'EBUSY' ||
        err?.code === 'EPERM' ||
        err?.code === 'EACCES';
      if (!busy || i === tries - 1) {
        logger?.warn(`[hls] rm failed ${path}: ${err?.code ?? err}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 80 + i * 120));
    }
  }
}

export async function newestSegmentAgeMs(dir: string): Promise<number | null> {
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

export async function nextStartNumber(dir: string): Promise<number> {
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
export async function isPlaylistFresh(
  config: ConfigService,
  dir: string,
  maxAgeSec?: number,
): Promise<boolean> {
    const hlsTime = Number(config.get('HLS_TIME', 2));
    const listSize = Number(config.get('HLS_LIST_SIZE', 30));
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
    const ageMs = await newestSegmentAgeMs(dir);
    if (ageMs == null) return false;
    return ageMs <= maxSec * 1000;
  }

/** Append only if every .ts listed in m3u8 is actually on disk. */
export async function isPlaylistAppendable(
  logger: Logger,
  dir: string,
): Promise<boolean> {
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
        logger.warn(`[hls] missing segment ${name} — not appendable`);
        return false;
      }
    }
    return true;
  }

/** Full HLS wipe after end of air: .ts + .m3u8 + concat. Never throws (Windows EBUSY). */
export async function clearHlsFolder(
  logger: Logger,
  dir: string,
): Promise<void> {
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
      .map((n) => safeRm(logger, join(dir, n))),
  );
  logger.log(`[hls] cleared folder ${dir}`);
}

export async function clearHlsArtifacts(dir: string): Promise<void> {
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
      .map((n) => safeRm(undefined, join(dir, n))),
  );
}

/**
 * Deletes playlist*.ts files that are not in the current m3u8.
 * ffmpeg delete_segments does not clean "holes" after append/restarts — leftover episode junk.
 */
export async function sweepOrphanSegments(
  logger: Logger,
  dir: string,
): Promise<void> {
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
          await safeRm(logger, full);
          removed += 1;
        } catch {
          /* ignore */
        }
      }),
    );
    if (removed > 0) {
      logger.log(`[hls] swept ${removed} orphan .ts in ${dir}`);
    }
  }

export async function waitForPlaylist(
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
