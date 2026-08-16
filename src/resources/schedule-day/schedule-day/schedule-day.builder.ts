import { ChannelCartoon, ChannelEpisode } from '@entities';
import { clamp, mulberry32, pickWeighted, shuffleArraySeeded } from '@func';
import { CreateScheduleItemDto } from '../schedule-item/dto/create-schedule-item.dto';

export type BuiltDayPlaylist = {
  items: CreateScheduleItemDto[];
  cursorTouched: Map<number, ChannelCartoon>;
};

export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function scheduleSeed(channelId: number, date: string): number {
  let h = 2166136261 ^ channelId;
  for (let i = 0; i < date.length; i++) {
    h = Math.imul(h ^ date.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export function playableEpisodes(cartoon: ChannelCartoon): ChannelEpisode[] {
  return (cartoon.episodes ?? [])
    .filter(
      (e) =>
        e.kind === 'episode' && e.isActive && (e.durationSec ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber ||
        a.episodeNumber - b.episodeNumber,
    );
}

/** Next regular episode after cursor; wraps to the first. */
export function pickNextEpisode(
  cartoon: ChannelCartoon,
): ChannelEpisode | null {
  const episodes = playableEpisodes(cartoon);
  if (!episodes.length) return null;

  const next =
    episodes.find(
      (e) =>
        e.seasonNumber > cartoon.cursorSeason ||
        (e.seasonNumber === cartoon.cursorSeason &&
          e.episodeNumber > cartoon.cursorEpisode),
    ) ?? episodes[0];

  cartoon.cursorSeason = next.seasonNumber;
  cartoon.cursorEpisode = next.episodeNumber;
  return next;
}

/** Fill airTimeSec with weighted shows + linear episode cursors. */
export function buildDayPlaylist(
  scheduleDayId: number,
  channelId: number,
  date: string,
  cartoons: ChannelCartoon[],
  airTimeSec: number,
): BuiltDayPlaylist {
  const eligible = cartoons.filter((c) => playableEpisodes(c).length > 0);
  if (!eligible.length) {
    return { items: [], cursorTouched: new Map() };
  }

  const seed = scheduleSeed(channelId, date);
  const random = mulberry32(seed);
  const pool = shuffleArraySeeded(eligible, seed);
  const items: CreateScheduleItemDto[] = [];
  const cursorTouched = new Map<number, ChannelCartoon>();
  let filledSec = 0;

  while (filledSec < airTimeSec && pool.length > 0) {
    const slot = nextPlaylistSlot(pool, random, scheduleDayId, items.length);
    if (!slot) continue;
    items.push(slot.item);
    filledSec += slot.item.durationSec;
    cursorTouched.set(slot.cartoon.id, slot.cartoon);
  }

  return { items, cursorTouched };
}

function nextPlaylistSlot(
  pool: ChannelCartoon[],
  random: () => number,
  scheduleDayId: number,
  order: number,
): { item: CreateScheduleItemDto; cartoon: ChannelCartoon } | null {
  const [cartoon] = pickWeighted(
    pool.map((c) => ({
      weight: clamp(c.weight || 1, 0.01, 1000),
      value: c,
    })),
    2,
    random,
  );
  const episode = pickNextEpisode(cartoon);
  if (!episode?.durationSec) {
    const idx = pool.indexOf(cartoon);
    if (idx >= 0) pool.splice(idx, 1);
    return null;
  }
  return {
    cartoon,
    item: {
      scheduleDayId,
      episodeId: episode.id,
      order,
      durationSec: episode.durationSec,
      source: 'regular',
    },
  };
}
