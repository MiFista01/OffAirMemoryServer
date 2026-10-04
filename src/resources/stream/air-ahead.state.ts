import { access, chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ScheduleItem } from '@entities';

export const AIR_AHEAD_FILE = 'air-ahead.json';

/**
 * Episodes finished on continuous air while wall-clock still sits on their grid
 * slot (file shorter than schedule durationSec). Without this, /start falls back
 * to wall-clock mid-slot and rolls the viewer back from the ending → ~80%.
 */
export type AirAheadState = {
  date: string;
  episodeIds: number[];
  scheduleItemIds?: number[];
  savedAt: string;
};

export function airAheadPath(dir: string): string {
  return join(dir, AIR_AHEAD_FILE);
}

export async function readAirAhead(
  dir: string,
): Promise<AirAheadState | null> {
  try {
    const raw = await readFile(airAheadPath(dir), 'utf8');
    const data = JSON.parse(raw) as AirAheadState;
    if (!data?.date || !Array.isArray(data.episodeIds)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function writeAirAhead(
  dir: string,
  state: AirAheadState,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755).catch(() => undefined);
  await writeFile(
    airAheadPath(dir),
    JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  await chmod(airAheadPath(dir), 0o644).catch(() => undefined);
}

export async function clearAirAhead(dir: string): Promise<void> {
  try {
    await rm(airAheadPath(dir), { force: true });
  } catch {
    /* ignore */
  }
}

export async function hasAirAhead(dir: string): Promise<boolean> {
  try {
    await access(airAheadPath(dir));
    return true;
  } catch {
    return false;
  }
}

/** Merge finished episode ids; keep until wall-clock moves past their slots. */
export async function markAirAhead(
  dir: string,
  date: string,
  episodeIds: number[],
  scheduleItemIds?: number[],
): Promise<AirAheadState> {
  const prev = await readAirAhead(dir);
  const ids = new Set<number>(
    prev?.date === date ? prev.episodeIds : [],
  );
  for (const id of episodeIds) {
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  const itemIds = new Set<number>(
    prev?.date === date ? (prev.scheduleItemIds ?? []) : [],
  );
  for (const id of scheduleItemIds ?? []) {
    if (Number.isFinite(id) && id > 0) itemIds.add(id);
  }
  const next: AirAheadState = {
    date,
    episodeIds: [...ids],
    scheduleItemIds: itemIds.size ? [...itemIds] : undefined,
    savedAt: new Date().toISOString(),
  };
  if (!next.episodeIds.length) {
    await clearAirAhead(dir);
    return next;
  }
  await writeAirAhead(dir, next);
  return next;
}

/**
 * Drop ids whose schedule order is already behind wall-clock (grid caught up).
 * Keep when wall still sits on / before that slot (air finished early).
 */
export function pruneAirAheadIds(
  episodeIds: number[],
  items: ScheduleItem[] | null | undefined,
  wallOrder: number | undefined,
): number[] {
  if (!episodeIds.length) return [];
  if (wallOrder == null || !items?.length) return episodeIds;
  const epIdOf = (item: ScheduleItem) => item.episode?.id ?? item.episodeId;
  return episodeIds.filter((id) => {
    const item = items.find((i) => epIdOf(i) === id);
    if (!item) return false;
    return wallOrder <= item.order;
  });
}
