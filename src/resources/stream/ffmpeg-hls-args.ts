import { ConfigService } from '@nestjs/config';

export type FfmpegHwMode = 'none' | 'vaapi' | 'qsv';

export function hwMode(config: ConfigService): FfmpegHwMode {
  const raw = (config.get<string>('FFMPEG_HW', 'none') ?? 'none')
    .trim()
    .toLowerCase();
  if (raw === 'vaapi' || raw === 'qsv') return raw;
  return 'none';
}

/** Must appear before `-i` (VAAPI device init). */
export function hwInitArgs(config: ConfigService): string[] {
  if (hwMode(config) !== 'vaapi') return [];
  const dev = config.get<string>(
    'FFMPEG_VAAPI_DEVICE',
    '/dev/dri/renderD128',
  );
  return ['-init_hw_device', `vaapi=va:${dev}`, '-filter_hw_device', 'va'];
}

export function parseArgs(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

export function videoEncodeArgs(config: ConfigService): string[] {
  const override = config.get<string>('FFMPEG_VIDEO_ARGS');
  if (override?.trim()) return parseArgs(override);

  if (hwMode(config) === 'vaapi') {
    // ~2.2 Mbps + ≤720p: ~1 GB/h mobile vs former 4 Mbps (~2 GB/h).
    // scale before hwupload (no upscale if source already smaller).
    return parseArgs(
      "-vf scale=w='min(1280,iw)':h=-2,format=nv12,hwupload -c:v h264_vaapi -b:v 2200k -maxrate 2500k -bufsize 5000k -g 48",
    );
  }
  if (hwMode(config) === 'qsv') {
    return parseArgs(
      "-vf scale=w='min(1280,iw)':h=-2 -c:v h264_qsv -preset veryfast -look_ahead 0 -b:v 2200k -maxrate 2500k -bufsize 5000k -g 48",
    );
  }
  return parseArgs(
    "-vf scale=w='min(1280,iw)':h=-2 -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -crf 23 -maxrate 2200k -bufsize 4400k -g 48 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv",
  );
}

export function buildHlsArgs(
  config: ConfigService,
  listPath: string,
  playlist: string,
  append: boolean,
  startNumber: number,
): string[] {
  const audioArgs = parseArgs(
    config.get<string>('FFMPEG_AUDIO_ARGS', '-c:a aac -b:a 96k'),
  );
  const listSize = String(config.get<number>('HLS_LIST_SIZE', 48));
  const hlsTime = String(config.get<number>('HLS_TIME', 2));
  // temp_file: atomic m3u8 write (no window where Nest serves 404 on the playlist).
  // discont_start on append: new ffmpeg PTS must not blend with prior window
  // (Infinite Train audio under Generator Rex video after mid-seam /start).
  const flags = append
    ? 'delete_segments+omit_endlist+independent_segments+append_list+discont_start+temp_file'
    : 'delete_segments+omit_endlist+independent_segments+temp_file';

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    ...hwInitArgs(config),
    '-re',
    '-fflags',
    '+genpts',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    ...videoEncodeArgs(config),
    ...audioArgs,
    '-avoid_negative_ts',
    'make_zero',
    '-f',
    'hls',
    '-hls_time',
    hlsTime,
    '-hls_list_size',
    listSize,
    '-hls_delete_threshold',
    '24',
    '-start_number',
    String(startNumber),
    '-hls_flags',
    flags,
    playlist,
  ];
}

/** Fast mid-episode seek: -ss before -i (keyframe), no concat inpoint. */
export function buildHlsArgsFastSeek(
  config: ConfigService,
  mediaPath: string,
  inpointSec: number,
  durationSec: number,
  playlist: string,
  append: boolean,
  startNumber: number,
): string[] {
  const audioArgs = parseArgs(
    config.get<string>('FFMPEG_AUDIO_ARGS', '-c:a aac -b:a 96k'),
  );
  const listSize = String(config.get<number>('HLS_LIST_SIZE', 48));
  const hlsTime = String(config.get<number>('HLS_TIME', 2));
  const flags = append
    ? 'delete_segments+omit_endlist+independent_segments+append_list+discont_start+temp_file'
    : 'delete_segments+omit_endlist+independent_segments+temp_file';
  const ss = Math.max(0, inpointSec);
  const dur = Math.max(1, durationSec - 0.05);

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    ...hwInitArgs(config),
    '-ss',
    String(ss),
    '-re',
    '-fflags',
    '+genpts',
    '-i',
    mediaPath,
    '-t',
    String(dur),
    ...videoEncodeArgs(config),
    ...audioArgs,
    '-avoid_negative_ts',
    'make_zero',
    '-f',
    'hls',
    '-hls_time',
    hlsTime,
    '-hls_list_size',
    listSize,
    '-hls_delete_threshold',
    '24',
    '-start_number',
    String(startNumber),
    '-hls_flags',
    flags,
    playlist,
  ];
}
