import { PlaylistSegment } from '@app-types';
import { ScheduleItem } from '@entities';

/** YYYY-MM-DD in IANA timezone (e.g. Europe/Tallinn). */
export function calendarDateInTz(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Offset: (wall-clock-as-UTC) − instant. Used to map local time → UTC. */
function tzOffsetMs(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

/**
 * Wall-clock `date` + `HH:mm` in `tz` → absolute Date.
 * Two-pass offset handles DST edges.
 */
export function windowStartAt(
  date: string,
  windowStart = '08:00',
  tz = 'Europe/Tallinn',
): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = windowStart.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, m, 0);
  const once = new Date(asUtc - tzOffsetMs(tz, new Date(asUtc)));
  return new Date(asUtc - tzOffsetMs(tz, once));
}

/** End of the air window: start + N hours. */
export function windowEndAt(airStart: Date, airTimeHours: number): Date {
  return new Date(airStart.getTime() + airTimeHours * 60 * 60 * 1000);
}

export function isWithinAirWindow(
  airStart: Date,
  airTimeHours: number,
  now = new Date(),
): boolean {
  const t = now.getTime();
  return t >= airStart.getTime() && t < windowEndAt(airStart, airTimeHours).getTime();
}

/**
 * Episodes whose start is before the window end. The current one may overrun and finish;
 * later ones after the cutoff are not added to concat.
 */
export function trimPlaylistToAirEnd(
  remaining: PlaylistSegment[],
  airTimeHours: number,
  airStart: Date,
  now = new Date(),
): PlaylistSegment[] {
  if (!remaining.length) return remaining;
  const windowEnd = windowEndAt(airStart, airTimeHours).getTime();
  // absolute start of the current slot
  let absStart = now.getTime() - remaining[0].inpointSec * 1000;
  const out: PlaylistSegment[] = [];
  for (const seg of remaining) {
    if (absStart >= windowEnd) break;
    out.push(seg);
    absStart += seg.item.durationSec * 1000;
  }
  return out;
}

/** After the limit: finish only the slot that started before the window end. */
export function isFinishingOverrun(
  items: ScheduleItem[] | null | undefined,
  airStart: Date,
  airTimeHours: number,
  now = new Date(),
): boolean {
  if (!items?.length) return false;
  if (isWithinAirWindow(airStart, airTimeHours, now)) return false;
  if (now.getTime() < airStart.getTime()) return false;

  const windowEnd = windowEndAt(airStart, airTimeHours).getTime();
  const nowMs = now.getTime();
  const sorted = [...items].sort((a, b) => a.order - b.order);
  let cursor = airStart.getTime();
  for (const item of sorted) {
    const end = cursor + item.durationSec * 1000;
    if (nowMs >= cursor && nowMs < end) {
      return cursor < windowEnd;
    }
    cursor = end;
  }
  return false;
}

/** key = `slug:Europe/Tallinn:720p` */
export function parseStreamKey(key: string): {
  slug: string;
  tz: string;
  profile: string;
} {
  const i = key.indexOf(':');
  const j = key.lastIndexOf(':');
  return {
    slug: key.slice(0, i),
    tz: key.slice(i + 1, j),
    profile: key.slice(j + 1),
  };
}

export function findCurrentSlot(
  items: ScheduleItem[] | null | undefined,
  airStart: Date,
  now = new Date(),
): { item: ScheduleItem; offsetSec: number } | null {
  if (!items?.length) return null;
  const sorted = [...items].sort((a, b) => a.order - b.order);
  let cursor = airStart.getTime();

  for (const item of sorted) {
    const end = cursor + item.durationSec * 1000;
    if (now.getTime() >= cursor && now.getTime() < end) {
      return {
        item,
        offsetSec: Math.floor((now.getTime() - cursor) / 1000),
      };
    }
    cursor = end;
  }
  return null; // OFF AIR
}

export function streamFolderName(
  slug: string,
  tz: string,
  profile: string,
): string {
  const tzSafe = tz.replace(/\//g, '-');
  return `${slug}_${tzSafe}_${profile}`;
}

export function findRemainingPlaylist(
  items: ScheduleItem[] | null | undefined,
  airStart: Date,
  now = new Date(),
): PlaylistSegment[] | null {
  if (!items?.length) return null;
  const sorted = [...items].sort((a, b) => a.order - b.order);
  let cursor = airStart.getTime();
  const out: PlaylistSegment[] = [];
  let started = false;
  for (const item of sorted) {
    const end = cursor + item.durationSec * 1000;
    if (!started) {
      if (now.getTime() >= cursor && now.getTime() < end) {
        const inpointSec = Math.floor((now.getTime() - cursor) / 1000);
        out.push({
          item,
          inpointSec,
          durationSec: Math.max(1, item.durationSec - inpointSec),
        });
        started = true;
      }
    } else {
      out.push({ item, inpointSec: 0, durationSec: item.durationSec });
    }
    cursor = end;
  }
  return started ? out : null;
}

/**
 * Next grid items after episodes we just finished/skipped (schedule order).
 * Used on encode seams so a late Transformers ending cannot wall-clock-skip Bakugan.
 */
export function findPlaylistAfterCompleted(
  items: ScheduleItem[] | null | undefined,
  completedEpisodeIds: number[],
  hintScheduleItemId?: number,
): PlaylistSegment[] | null {
  if (!items?.length || !completedEpisodeIds.length) return null;
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const done = new Set(completedEpisodeIds);
  const epIdOf = (item: ScheduleItem) => item.episode?.id ?? item.episodeId;

  let lastIdx = -1;
  if (hintScheduleItemId != null) {
    const hintIdx = sorted.findIndex((i) => i.id === hintScheduleItemId);
    if (hintIdx >= 0) {
      lastIdx = hintIdx;
      for (let i = hintIdx; i < sorted.length; i++) {
        if (done.has(epIdOf(sorted[i]))) lastIdx = i;
        else break;
      }
    }
  }
  if (lastIdx < 0) {
    for (let i = 0; i < sorted.length; i++) {
      if (done.has(epIdOf(sorted[i]))) lastIdx = i;
    }
  }
  if (lastIdx < 0 || lastIdx >= sorted.length - 1) return null;

  return sorted.slice(lastIdx + 1).map((item) => ({
    item,
    inpointSec: 0,
    durationSec: item.durationSec,
  }));
}