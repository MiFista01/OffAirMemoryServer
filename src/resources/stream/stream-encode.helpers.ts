import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIR_WINDOW_START } from '@constants';
import { getVideoDurationSec } from '../channels/scan/video-duration';
import {
  readAirFinish,
  writeAirFinish,
} from './air-finish.state';
import { calendarDateInTz } from './stream-air.util';
import type { HlsSegmentInput } from './stream-encode.types';

export type { HlsSegmentInput } from './stream-encode.types';

/**
 * Grid duration can exceed real file length (bad scan / bad inpoint).
 * Clamp ffmpeg window so solo -ss/-t does not EOF instantly (CN Johnny Bravo etc.).
 */
export async function clampSegmentsToFile(
  logger: Logger,
  segments: HlsSegmentInput[],
  episodeId?: number,
): Promise<{
  segments: HlsSegmentInput[];
  skipEpisodeId?: number;
  path?: string;
}> {
  if (!segments.length) return { segments };
  const head = segments[0];
  const fileDur = await getVideoDurationSec(head.path);
  if (fileDur == null || fileDur <= 0) return { segments };

  const inpoint = Math.min(
    Math.max(0, head.inpointSec),
    Math.max(0, fileDur - 0.5),
  );
  const available = fileDur - inpoint;
  if (available <= 0.75) {
    return {
      segments,
      skipEpisodeId: episodeId,
      path: head.path,
    };
  }

  const duration = Math.min(
    head.durationSec,
    Math.max(1, available - 0.5),
  );
  if (
    Math.abs(duration - head.durationSec) > 1.5 ||
    Math.abs(inpoint - head.inpointSec) > 0.5
  ) {
    logger.warn(
      `[stream] clamp ${head.path}: in ${head.inpointSec}s→${inpoint}s, ` +
        `dur ${head.durationSec}s→${duration}s (file ${fileDur.toFixed(1)}s)`,
    );
  }

  const out = [...segments];
  out[0] = { ...head, inpointSec: inpoint, durationSec: duration };
  return { segments: out };
}

/** Encode is already near the slot ending (job durationSec = remaining at start). */
export function isJobNearEpisodeEnd(job: {
  startedAt?: number;
  offsetSec?: number;
  durationSec?: number;
}): boolean {
  const remainingAtStart = job.durationSec ?? 0;
  if (remainingAtStart <= 0) return false;
  const started = job.startedAt ?? Date.now();
  const elapsed = (Date.now() - started) / 1000;
  // Previously we wrongly compared inpoint+elapsed to remaining → always "near end".
  return elapsed >= Math.max(0, remainingAtStart - 60);
}

export function capLookahead<T extends { durationSec: number }>(
  segments: T[],
  maxSec: number,
): T[] {
  const out: T[] = [];
  let acc = 0;
  for (const seg of segments) {
    out.push(seg);
    acc += seg.durationSec;
    if (acc >= maxSec) break;
  }
  return out;
}

export async function ensureFinishFromJob(
  job: {
    episodeId?: number;
    scheduleItemId?: number;
    offsetSec?: number;
    source?: string;
    mediaPath?: string;
    relativePath?: string;
    durationSec?: number;
    startedAt?: number;
  },
  dir: string,
  date?: string,
): Promise<void> {
  if (await readAirFinish(dir)) return;
  if (!job.mediaPath || !job.episodeId || !job.durationSec) return;
  const elapsed = Math.max(
    0,
    (Date.now() - (job.startedAt ?? Date.now())) / 1000,
  );
  await writeAirFinish(dir, {
    date: date ?? calendarDateInTz('Europe/Tallinn'),
    episodeId: job.episodeId,
    scheduleItemId: job.scheduleItemId,
    mediaPath: job.mediaPath,
    relativePath: job.relativePath ?? '',
    inpointSec: Math.floor((job.offsetSec ?? 0) + elapsed),
    durationSec: Math.max(1, Math.floor(job.durationSec - elapsed)),
    source: job.source ?? 'regular',
    policy: 'continuous',
    generation: 1,
    savedAt: new Date().toISOString(),
  });
}

export function jobResponse(
  config: ConfigService,
  slug: string,
  job: {
    playlistUrl: string;
    episodeId?: number;
    offsetSec?: number;
    source?: string;
    remainingCount?: number;
    ready?: boolean;
  },
) {
  const ready = !!job.ready;
  return {
    channel: slug,
    streamUrl: ready ? job.playlistUrl : null,
    episodeId: job.episodeId ?? 0,
    offsetSec: job.offsetSec ?? 0,
    source: job.source ?? 'regular',
    remainingCount: job.remainingCount ?? 0,
    encodeWindowSec: 0,
    airWindowStart: config.get<string>('AIR_WINDOW_START', AIR_WINDOW_START),
    ready,
    playable: ready,
    status: ready ? ('live' as const) : ('starting' as const),
    pollAfterMs: ready ? undefined : 2000,
    message: ready
      ? undefined
      : 'Эфир есть, подготавливаем поток — подождите несколько секунд',
  };
}
