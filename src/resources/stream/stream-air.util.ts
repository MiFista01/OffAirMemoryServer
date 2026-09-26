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

export function findCurrentSlot(
  items: ScheduleItem[],
  airStart: Date,
  now = new Date(),
): { item: ScheduleItem; offsetSec: number } | null {
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
  items: ScheduleItem[],
  airStart: Date,
  now = new Date(),
): PlaylistSegment[] | null {
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