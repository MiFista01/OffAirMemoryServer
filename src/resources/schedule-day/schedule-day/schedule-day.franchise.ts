import { ChannelCartoon, ChannelEpisode } from '@entities';

export function playableRegulars(cartoon: ChannelCartoon): ChannelEpisode[] {
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

export function hasRemainingAfterCursor(cartoon: ChannelCartoon): boolean {
  return playableRegulars(cartoon).some(
    (e) =>
      e.seasonNumber > cartoon.cursorSeason ||
      (e.seasonNumber === cartoon.cursorSeason &&
        e.episodeNumber > cartoon.cursorEpisode),
  );
}

/**
 * One roulette entry per franchise: active era (lowest unfinished eraOrder),
 * or first era if all finished. Standalone shows (no franchiseKey) as-is.
 */
export function franchisePool(cartoons: ChannelCartoon[]): ChannelCartoon[] {
  const groups = new Map<string, ChannelCartoon[]>();
  const singles: ChannelCartoon[] = [];

  for (const c of cartoons) {
    if (!c.franchiseKey) {
      if (playableRegulars(c).length) singles.push(c);
      continue;
    }
    const list = groups.get(c.franchiseKey) ?? [];
    list.push(c);
    groups.set(c.franchiseKey, list);
  }

  const reps = [...singles];
  for (const group of groups.values()) {
    const era = pickActiveEra(group);
    if (era && playableRegulars(era).length) reps.push(era);
  }
  return reps;
}

function pickActiveEra(group: ChannelCartoon[]): ChannelCartoon | null {
  const sorted = [...group].sort(
    (a, b) => (a.eraOrder ?? 0) - (b.eraOrder ?? 0),
  );
  return sorted.find((c) => hasRemainingAfterCursor(c)) ?? sorted[0] ?? null;
}

/** After an era wraps, swap pool entry to the next era (or first). */
export function advanceFranchiseEra(
  pool: ChannelCartoon[],
  finished: ChannelCartoon,
  allCartoons: ChannelCartoon[],
): ChannelCartoon | null {
  if (!finished.franchiseKey) return finished;

  const group = allCartoons
    .filter((c) => c.franchiseKey === finished.franchiseKey)
    .sort((a, b) => (a.eraOrder ?? 0) - (b.eraOrder ?? 0));
  if (group.length <= 1) return finished;

  const idx = group.findIndex((c) => c.id === finished.id);
  const next = group[(idx + 1) % group.length];
  const poolIdx = pool.findIndex((c) => c.id === finished.id);
  if (poolIdx >= 0) pool[poolIdx] = next;
  return next;
}

export function specialsAfterEpisode(
  cartoon: ChannelCartoon,
  episodeId: number,
): ChannelEpisode[] {
  return (cartoon.episodes ?? []).filter(
    (e) =>
      e.kind === 'special' &&
      e.isActive &&
      (e.durationSec ?? 0) > 0 &&
      e.insertAfterEpisodeId === episodeId,
  );
}
