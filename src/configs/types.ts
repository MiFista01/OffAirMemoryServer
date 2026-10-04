import { Request } from 'express';
import { UserProfile } from 'src/resources/user/profile/entities/profile.entity';
import { UserAuth } from 'src/resources/user/auth/entities/auth.entity';
import { Channel, ChannelCartoon, ScheduleItem } from '@entities';
import { ChildProcessWithoutNullStreams } from 'child_process';

export type ReqWithUser = Request & {
  user: {
    userId: number;
    uuid: string;
    exp: number;
  };
  profile?: UserProfile;
  auth?: UserAuth;
  getProfile: () => Promise<UserProfile>;
  getAuth: () => Promise<UserAuth>;
};

export interface FileCleanerOptions {
  folder: string;
  fieldName: string;
  cleanUp: boolean;
}

export type MediaScanStatus = {
  processStartedAt: string;
  uptimeSec: number;
  lifecycle: string | null;
  scanOnBoot: boolean;
  isScanning: boolean;
  lastScan: {
    at: string;
    durationMs: number;
    created: ScanCounters;
    existing: ScanCounters;
    removed: ScanCounters;
    reactivated: ScanCounters;
    durations: { filled: number; failed: number };
    error: string | null;
  } | null;
  counts: ScanCounters;
};

export type ScanCounters = {
  channels: number;
  cartoons: number;
  episodes: number;
};

export type ScanEpisodeRef = {
  id: number;
  cartoonId: number;
  relativePath: string;
  isActive: boolean;
};

export type ScanIndex = {
  channelBySlug: Map<string, Channel>;
  cartoonByKey: Map<string, ChannelCartoon>;
  /** cartoonId:relativePath → episode row */
  episodeByPath: Map<string, ScanEpisodeRef>;
};

export type ScanContext = {
  root: string;
  index: ScanIndex;
  created: ScanCounters;
  existing: ScanCounters;
  removed: ScanCounters;
  reactivated: ScanCounters;
  /** Paths seen on disk this scan (cartoonId:relativePath). */
  seenEpisodePaths: Set<string>;
};

export type FfmpegJob = {
  key: string;
  process: ChildProcessWithoutNullStreams;
  dir: string;
  playlistUrl: string; // /stream/.../playlist.m3u8
  lastAccessAt: number;
  startedAt?: number;
  /** First .ts already exists — safe to hand to the player. */
  ready?: boolean;
  onNaturalEnd?: (meta: { rolling: boolean }) => void | Promise<void>;
  episodeId?: number;
  scheduleItemId?: number;
  offsetSec?: number;
  source?: string;
  remainingCount?: number;
  mediaPath?: string;
  relativePath?: string;
  /** Remaining duration of the *head* episode at encode start (not full bridge). */
  durationSec?: number;
  /** Sum of all concat segments (A+B on seam bridge). Use for near-end checks. */
  encodeWindowSec?: number;
  /** Number of media files in this ffmpeg concat (≥2 = seam bridge). */
  segmentCount?: number;
  /** Dual-slot toggle: a|b subfolder under channel HLS dir. */
  slot?: 'a' | 'b';
  /** Channel key without slot (`slug:tz:profile`). */
  channelKey?: string;
};

export enum StreamProfile {
  P720 = '720p',
  P480 = '480p',
}

export type PlaylistSegment = {
  item: ScheduleItem;
  inpointSec: number;
  durationSec: number;
};