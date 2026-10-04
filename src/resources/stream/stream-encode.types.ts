export type HlsSegmentInput = {
  path: string;
  inpointSec: number;
  durationSec: number;
};

/** Callbacks from StreamEncodeService — breaks circular DI (no ModuleRef under SWC). */
export type StreamRunEncodeHost = {
  airTimeHours(): number;
  loadScheduleDay(
    channelId: number,
    tz: string,
  ): Promise<{
    scheduleItems?: Array<{
      id: number;
      source?: string | null;
      episode?: { id: number; relativePath?: string | null } | null;
      episodeId?: number | null;
    }> | null;
  } | null>;
  runFinishEncode(
    slug: string,
    tz: string,
    profile: string,
    finish: import('./air-finish.state').AirFinishState,
    append: boolean,
    opts?: { bridgeNext?: boolean },
  ): Promise<unknown>;
  continueEncode(
    slug: string,
    tz: string,
    profile: string,
    opts?: {
      skipCurrent?: boolean;
      resumeCursor?: boolean;
      rolling?: boolean;
      completedEpisodeIds?: number[];
    },
  ): void | Promise<void> | Promise<'live' | 'off' | 'hold'>;
  /** Dual-slot: start next episode in the inactive slot while active keeps playing. */
  spawnStandby?(
    slug: string,
    tz: string,
    profile: string,
    opts: { completedEpisodeIds: number[] },
  ): void | Promise<void>;
  /** Dual-slot: flip active→standby and emit switch to clients. */
  promoteStandby?(
    slug: string,
    tz: string,
    profile: string,
  ): void | Promise<void>;
  /** Dual-slot: poll until standby ready + active near end, then promote. */
  watchStandbyPromote?(
    slug: string,
    tz: string,
    profile: string,
  ): void | Promise<void>;
  /**
   * True when the guide has left this schedule row (safe to start / promote next).
   */
  guidePastScheduleItem?(
    slug: string,
    tz: string,
    scheduleItemId: number,
  ): boolean | Promise<boolean>;
  /**
   * File/EOF finished early vs guide — do not start next row yet.
   * Schedules a delayed seam when wall-clock reaches the next slot.
   */
  holdForWallCatchUp(
    slug: string,
    tz: string,
    profile: string,
    completedEpisodeIds: number[],
    waitMs: number,
  ): void | Promise<void>;
  /**
   * When the guide leaves this schedule row, force wall-clock catch-up even if
   * ffmpeg is still encoding the previous cartoon (no F5 required).
   */
  armSlotEndCatchUp?(
    slug: string,
    tz: string,
    profile: string,
    scheduleItemId: number,
    episodeId: number,
    waitMs: number,
  ): void;
  /** Persist finished episodes for tomorrow's cursor (catch-up /runEncode paths). */
  recordFinishedEpisodes?(
    channelId: number,
    date: string,
    episodeIds: number[],
  ): void | Promise<void>;
};

export type StreamRunEncodeOpts = {
  skipCurrent?: boolean;
  onlyCurrent?: boolean;
  persistFinish?: boolean;
  completedEpisodeIds?: number[];
  /** Dual-slot: encode into this slot (standby prep). */
  targetSlot?: 'a' | 'b';
  /** Dual-slot: keep active encode running; write into standby only. */
  asStandby?: boolean;
};
