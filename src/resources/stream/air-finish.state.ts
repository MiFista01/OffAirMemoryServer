import { access, chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

export const AIR_FINISH_FILE = 'air-finish.json';

/**
 * AIR CURSOR — single source of truth for what a channel is encoding.
 * File name stays `air-finish.json` (compat); treat it as the air cursor.
 *
 * Rules (schedule / ffmpeg / Nest / client must all obey):
 * 1. continuous — viewer/session debt: finish the current cartoon even if the
 *    wall-clock grid has moved on. Seams advance to the *next schedule row*,
 *    never jump by wall-clock into a later slot.
 * 2. grid — no live debt (cold join / channel switch with no cursor): pick by
 *    wall-clock. Guide UI always *displays* wall-clock; it does not override
 *    an active continuous cursor.
 * 3. generation — bump whenever HLS is wiped or the episode changes. Client
 *    must /start + full reattach on gen change / zombie 404s — never remanifest
 *    a wiped playlist.
 * 4. Idle kill persists playhead into this file *before* clearing `.ts`.
 */

export type AirCursorPolicy = 'continuous' | 'grid';

export type AirFinishState = {
  /** Calendar air day (YYYY-MM-DD in channel tz). */
  date: string;
  episodeId: number;
  /** Schedule row id — sequential seams must not jump by wall-clock. */
  scheduleItemId?: number;
  mediaPath: string;
  relativePath: string;
  inpointSec: number;
  durationSec: number;
  source: string;
  savedAt: string;
  /** continuous = stay on debt; grid = wall-clock (default for legacy files). */
  policy?: AirCursorPolicy;
  /** Increments on HLS wipe / episode change. */
  generation?: number;
};

export function airFinishPath(dir: string): string {
  return join(dir, AIR_FINISH_FILE);
}

export async function readAirFinish(
  dir: string,
): Promise<AirFinishState | null> {
  try {
    const raw = await readFile(airFinishPath(dir), 'utf8');
    const data = JSON.parse(raw) as AirFinishState;
    if (!data?.mediaPath || !data.durationSec) return null;
    return data;
  } catch {
    return null;
  }
}

export async function writeAirFinish(
  dir: string,
  state: AirFinishState,
): Promise<void> {
  // /start writes air-finish before ffmpeg mkdir — cold STREAM_ROOT → ENOENT → 500
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755).catch(() => undefined);
  await writeFile(
    airFinishPath(dir),
    JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  await chmod(airFinishPath(dir), 0o644).catch(() => undefined);
}

export async function clearAirFinish(dir: string): Promise<void> {
  try {
    await rm(airFinishPath(dir), { force: true });
  } catch {
    /* ignore */
  }
}

export async function hasAirFinish(dir: string): Promise<boolean> {
  try {
    await access(airFinishPath(dir));
    return true;
  } catch {
    return false;
  }
}

/** Next generation after a wipe / episode change. */
export async function nextCursorGeneration(dir: string): Promise<number> {
  const prev = await readAirFinish(dir);
  return (prev?.generation ?? 0) + 1;
}
