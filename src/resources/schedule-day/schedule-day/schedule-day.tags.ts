import { BroadcastWindowKind } from '@constants';
import { BroadcastWindow, ChannelCartoon, ChannelEpisode } from '@entities';

export type DayTagEffects = {
  /** cartoonId → weight multiplier from active boost windows */
  weightMul: Map<number, number>;
  /** cartoons blocked by active exclude */
  excluded: Set<number>;
  /** cartoons that have only_during tags (must be in activeOnly to air) */
  gated: Set<number>;
  /** gated cartoons currently allowed */
  activeOnly: Set<number>;
  /** playable specials whose tags match an active holiday window */
  holidaySpecials: ChannelEpisode[];
};

export function dateToMd(date: string): string {
  return date.slice(5); // YYYY-MM-DD → MM-DD
}

export function mdInRange(md: string, startMd: string, endMd: string): boolean {
  if (startMd <= endMd) return md >= startMd && md <= endMd;
  return md >= startMd || md <= endMd;
}

function activeWindows(
  windows: BroadcastWindow[] | undefined,
  md: string,
): BroadcastWindow[] {
  return (windows ?? []).filter((w) => mdInRange(md, w.startMd, w.endMd));
}

/** Resolve exclude / only_during / boost / holiday specials for a calendar day. */
export function resolveDayTagEffects(
  cartoons: ChannelCartoon[],
  date: string,
): DayTagEffects {
  const md = dateToMd(date);
  const weightMul = new Map<number, number>();
  const excluded = new Set<number>();
  const gated = new Set<number>();
  const activeOnly = new Set<number>();
  const holidaySpecials: ChannelEpisode[] = [];
  const seenHoliday = new Set<number>();

  for (const cartoon of cartoons) {
    applyCartoonWindows(cartoon, md, weightMul, excluded, gated, activeOnly);
    for (const ep of cartoon.episodes ?? []) {
      collectHolidaySpecial(ep, md, holidaySpecials, seenHoliday);
    }
  }

  return { weightMul, excluded, gated, activeOnly, holidaySpecials };
}

function applyCartoonWindows(
  cartoon: ChannelCartoon,
  md: string,
  weightMul: Map<number, number>,
  excluded: Set<number>,
  gated: Set<number>,
  activeOnly: Set<number>,
) {
  let mul = 1;
  let hasOnlyDuring = false;
  let onlyActive = false;

  for (const tag of cartoon.broadcastTags ?? []) {
    for (const w of activeWindows(tag.windows, md)) {
      if (w.kind === BroadcastWindowKind.EXCLUDE) excluded.add(cartoon.id);
      if (w.kind === BroadcastWindowKind.BOOST) mul *= w.multiplier || 1;
      if (w.kind === BroadcastWindowKind.ONLY_DURING) {
        hasOnlyDuring = true;
        onlyActive = true;
      }
    }
    for (const w of tag.windows ?? []) {
      if (w.kind === BroadcastWindowKind.ONLY_DURING) hasOnlyDuring = true;
    }
  }

  if (mul !== 1) weightMul.set(cartoon.id, mul);
  if (hasOnlyDuring) {
    gated.add(cartoon.id);
    if (onlyActive) activeOnly.add(cartoon.id);
  }
}

function collectHolidaySpecial(
  ep: ChannelEpisode,
  md: string,
  out: ChannelEpisode[],
  seen: Set<number>,
) {
  if (ep.kind !== 'special' || !ep.isActive || !(ep.durationSec ?? 0)) return;
  if (seen.has(ep.id)) return;

  const holiday = (ep.broadcastTags ?? []).some((tag) =>
    activeWindows(tag.windows, md).some(
      (w) =>
        w.kind === BroadcastWindowKind.BOOST ||
        w.kind === BroadcastWindowKind.ONLY_DURING,
    ),
  );
  if (!holiday) return;
  seen.add(ep.id);
  out.push(ep);
}

export function isCartoonEligible(
  cartoon: ChannelCartoon,
  effects: DayTagEffects,
): boolean {
  if (effects.excluded.has(cartoon.id)) return false;
  if (effects.gated.has(cartoon.id) && !effects.activeOnly.has(cartoon.id)) {
    return false;
  }
  return true;
}

export function effectiveWeight(
  cartoon: ChannelCartoon,
  effects: DayTagEffects,
): number {
  const base = cartoon.weight || 1;
  return base * (effects.weightMul.get(cartoon.id) ?? 1);
}
