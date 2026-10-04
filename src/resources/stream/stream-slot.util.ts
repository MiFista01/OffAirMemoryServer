import { STREAM_URL_PREFIX } from '@constants';
import { streamFolderName } from './stream-air.util';

/** Dual HLS encode slots per channel — toggle at seams. */
export type StreamSlot = 'a' | 'b';

export function otherSlot(slot: StreamSlot): StreamSlot {
  return slot === 'a' ? 'b' : 'a';
}

export function streamChannelKey(
  slug: string,
  tz: string,
  profile: string,
): string {
  return `${slug}:${tz}:${profile}`;
}

export function streamJobKey(
  slug: string,
  tz: string,
  profile: string,
  slot: StreamSlot,
): string {
  return `${streamChannelKey(slug, tz, profile)}:${slot}`;
}

/** Channel root (air-finish / air-ahead). HLS lives in a|b subfolders. */
export function streamChannelFolder(
  slug: string,
  tz: string,
  profile: string,
): string {
  return streamFolderName(slug, tz, profile);
}

/** Relative folder for one slot: `{channelFolder}/a` */
export function streamSlotFolder(
  slug: string,
  tz: string,
  profile: string,
  slot: StreamSlot,
): string {
  return `${streamChannelFolder(slug, tz, profile)}/${slot}`;
}

export function streamSlotPlaylistUrl(
  slug: string,
  tz: string,
  profile: string,
  slot: StreamSlot,
): string {
  return `${STREAM_URL_PREFIX}/${streamSlotFolder(slug, tz, profile, slot)}/playlist.m3u8`;
}

/** Parse `slug:tz:profile` or `slug:tz:profile:a|b`. */
export function parseStreamKeyWithSlot(key: string): {
  slug: string;
  tz: string;
  profile: string;
  slot?: StreamSlot;
} {
  const slotMatch = /:(a|b)$/.exec(key);
  const base = slotMatch ? key.slice(0, -2) : key;
  const slot = slotMatch ? (slotMatch[1] as StreamSlot) : undefined;
  const i = base.indexOf(':');
  const j = base.lastIndexOf(':');
  return {
    slug: base.slice(0, i),
    tz: base.slice(i + 1, j),
    profile: base.slice(j + 1),
    slot,
  };
}
