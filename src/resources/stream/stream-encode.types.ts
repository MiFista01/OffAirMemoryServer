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
  ): Promise<unknown>;
  continueEncode(
    slug: string,
    tz: string,
    profile: string,
    opts?: {
      skipCurrent?: boolean;
      resumeCursor?: boolean;
      completedEpisodeIds?: number[];
    },
  ): void | Promise<void>;
};

export type StreamRunEncodeOpts = {
  skipCurrent?: boolean;
  onlyCurrent?: boolean;
  persistFinish?: boolean;
  completedEpisodeIds?: number[];
};
