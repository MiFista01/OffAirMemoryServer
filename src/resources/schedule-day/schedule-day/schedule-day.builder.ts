import { ChannelCartoon, ChannelEpisode } from '@entities';
import { clamp, mulberry32, pickWeighted, shuffleArraySeeded } from '@func';
import { CreateScheduleItemDto } from '../schedule-item/dto/create-schedule-item.dto';
import {
  advanceFranchiseEra,
  franchisePool,
  playableRegulars,
  specialsAfterEpisode,
} from './schedule-day.franchise';
import {
  DayTagEffects,
  effectiveWeight,
  isCartoonEligible,
  resolveDayTagEffects,
} from './schedule-day.tags';

export type BuiltDayPlaylist = {
  items: CreateScheduleItemDto[];
  cursorTouched: Map<number, ChannelCartoon>;
};

const HOLIDAY_CHANCE = 0.12;

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

/** Next regular episode after cursor; wraps to the first. */
export function pickNextEpisode(
  cartoon: ChannelCartoon,
): { episode: ChannelEpisode; wrapped: boolean } | null {
  const episodes = playableRegulars(cartoon);
  if (!episodes.length) return null;

  const next = episodes.find(
    (e) =>
      e.seasonNumber > cartoon.cursorSeason ||
      (e.seasonNumber === cartoon.cursorSeason &&
        e.episodeNumber > cartoon.cursorEpisode),
  );
  const wrapped = !next;
  const episode = next ?? episodes[0];

  cartoon.cursorSeason = episode.seasonNumber;
  cartoon.cursorEpisode = episode.episodeNumber;
  return { episode, wrapped };
}

/** Fill airTimeSec: franchise roulette + insert specials + holiday tags. */
export function buildDayPlaylist(
  scheduleDayId: number,
  channelId: number,
  date: string,
  cartoons: ChannelCartoon[],
  airTimeSec: number,
): BuiltDayPlaylist {
  const effects = resolveDayTagEffects(cartoons, date);
  const eligible = cartoons.filter(
    (c) => isCartoonEligible(c, effects) && playableRegulars(c).length > 0,
  );
  const pool = franchisePool(eligible);
  if (!pool.length && !effects.holidaySpecials.length) {
    return { items: [], cursorTouched: new Map() };
  }

  const seed = scheduleSeed(channelId, date);
  const random = mulberry32(seed);
  const shuffled = shuffleArraySeeded(pool, seed);
  const holidayPool = [...effects.holidaySpecials];
  const items: CreateScheduleItemDto[] = [];
  const cursorTouched = new Map<number, ChannelCartoon>();
  let filledSec = 0;

  while (filledSec < airTimeSec && (shuffled.length > 0 || holidayPool.length)) {
    const useHoliday =
      holidayPool.length > 0 &&
      (shuffled.length === 0 || random() < HOLIDAY_CHANCE);

    if (useHoliday) {
      const added = pushHoliday(items, holidayPool, random, scheduleDayId);
      if (added) filledSec += added;
      continue;
    }

    const gained = pushRegularSlot(
      items,
      shuffled,
      eligible,
      effects,
      random,
      scheduleDayId,
      cursorTouched,
    );
    if (gained == null) continue;
    filledSec += gained;
  }

  return { items, cursorTouched };
}

function pushHoliday(
  items: CreateScheduleItemDto[],
  holidayPool: ChannelEpisode[],
  random: () => number,
  scheduleDayId: number,
): number | null {
  const idx = Math.floor(random() * holidayPool.length);
  const [ep] = holidayPool.splice(idx, 1);
  if (!ep?.durationSec) return null;
  items.push({
    scheduleDayId,
    episodeId: ep.id,
    order: items.length,
    durationSec: ep.durationSec,
    source: 'holiday',
  });
  return ep.durationSec;
}

function pushRegularSlot(
  items: CreateScheduleItemDto[],
  pool: ChannelCartoon[],
  allEligible: ChannelCartoon[],
  effects: DayTagEffects,
  random: () => number,
  scheduleDayId: number,
  cursorTouched: Map<number, ChannelCartoon>,
): number | null {
  if (!pool.length) return null;

  const [cartoon] = pickWeighted(
    pool.map((c) => ({
      weight: clamp(effectiveWeight(c, effects), 0.01, 1000),
      value: c,
    })),
    2,
    random,
  );

  const picked = pickNextEpisode(cartoon);
  if (!picked?.episode.durationSec) {
    const idx = pool.indexOf(cartoon);
    if (idx >= 0) pool.splice(idx, 1);
    return null;
  }

  const { episode, wrapped } = picked;
  let total = 0;
  total += appendItem(items, scheduleDayId, episode, 'regular');
  cursorTouched.set(cartoon.id, cartoon);

  for (const special of specialsAfterEpisode(cartoon, episode.id)) {
    total += appendItem(items, scheduleDayId, special, 'special_insert');
  }

  if (wrapped) {
    const nextEra = advanceFranchiseEra(pool, cartoon, allEligible);
    if (nextEra) cursorTouched.set(nextEra.id, nextEra);
  }

  return total;
}

function appendItem(
  items: CreateScheduleItemDto[],
  scheduleDayId: number,
  episode: ChannelEpisode,
  source: CreateScheduleItemDto['source'],
): number {
  const durationSec = episode.durationSec ?? 0;
  items.push({
    scheduleDayId,
    episodeId: episode.id,
    order: items.length,
    durationSec,
    source: source ?? 'regular',
  });
  return durationSec;
}
