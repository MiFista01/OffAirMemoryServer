import { access, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

export const AIR_FINISH_FILE = 'air-finish.json';

/** Persist finish-overrun of the last cartoon (survives Nest restart). */
export type AirFinishState = {
  /** Calendar air day (YYYY-MM-DD in channel tz). */
  date: string;
  episodeId: number;
  mediaPath: string;
  relativePath: string;
  inpointSec: number;
  durationSec: number;
  source: string;
  savedAt: string;
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
  await writeFile(
    airFinishPath(dir),
    JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
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
