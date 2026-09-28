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

export type ScanIndex = {
  channelBySlug: Map<string, Channel>;
  cartoonByKey: Map<string, ChannelCartoon>;
  episodeByPath: Set<string>;
};

export type ScanContext = {
  root: string;
  index: ScanIndex;
  created: ScanCounters;
  existing: ScanCounters;
};

export type FfmpegJob = {
  key: string;
  process: ChildProcessWithoutNullStreams;
  dir: string;
  playlistUrl: string; // /stream/.../playlist.m3u8
  lastAccessAt: number;
  startedAt?: number;
  /** Первый .ts уже есть — можно отдавать в плеер. */
  ready?: boolean;
  onNaturalEnd?: (meta: { rolling: boolean }) => void | Promise<void>;
  episodeId?: number;
  offsetSec?: number;
  source?: string;
  remainingCount?: number;
  mediaPath?: string;
  relativePath?: string;
  durationSec?: number;
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