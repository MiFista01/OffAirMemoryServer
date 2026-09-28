export const startEnvCheck = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_NAME',
  'FRONT_URL',
  'API_NAME',
  'JWT_KEY',
  'PROJECT_STATUS',
  'MEDIA_ROOT',
  'STREAM_ROOT',
];

// Sync cookiesDays with TOKEN_TIME in .env to avoid auth mismatches
export const dayMs = 1000 * 60 * 60 * 24;
export const cookiesDays = 2;

export const fileCleanerKey = 'fileCleaner';

export const keyWithoutLike = ['createdAt', 'updatedAt', 'slug'];

export const tokenCookieName = 'authToken';

/** Defaults if env missing — prefer AIR_WINDOW_START / AIR_TIME_HOURS in .env */
export const AIR_WINDOW_START = '08:00';
export const AIR_TIME_HOURS = 15;
/** @deprecated use AIR_TIME_HOURS */
export const airTimeHours = AIR_TIME_HOURS;
/** Public HLS path served by Nginx (must match deploy/nginx.conf). */
export const STREAM_URL_PREFIX = '/stream';
/** Stop ffmpeg if nobody watched (HLS /start) for this many seconds. */
export const STREAM_IDLE_TTL_SEC = 60;

export enum BroadcastWindowKind {
  BOOST = 'boost',
  ONLY_DURING = 'only_during',
  EXCLUDE = 'exclude',
}

export const SKIP_DIRS = new Set([
  '#recycle',
  '$recycle.bin',
  'system volume information',
  '.ds_store',
]);
export const SEASON_DIR = /^s(\d+)$/i;
export const SPECIALS_DIR = 'specials';
export const EPISODE_FILE = /^(\d+)\.(mp4|mkv|webm|avi)$/i;
export const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi']);
export const EPISODE_BATCH_SIZE = 200;
export const DURATION_CONCURRENCY = 8;

export const winstonLoggerTuner: {
  filename: string;
  level: string;
  logName: string;
  tagTrigger?: string;
  useMeta?: boolean;
}[] = [
  {
    filename: 'app',
    level: 'info',
    logName: 'Nest',
    useMeta: true,
  },
  {
    filename: 'success',
    level: 'info',
    logName: 'Interceptor',
    tagTrigger: 'Success',
    useMeta: false,
  },
  {
    filename: 'error',
    level: 'error',
    logName: 'Error',
    tagTrigger: 'Error',
    useMeta: true,
  },
  {
    filename: 'warn',
    level: 'warn',
    logName: 'Warn',
    tagTrigger: 'Warn',
    useMeta: true,
  },
  {
    filename: 'db-error',
    level: 'error',
    logName: 'DB-Error',
    tagTrigger: 'DB-Error',
    useMeta: false,
  },
  {
    filename: 'rate-limit',
    level: 'warn',
    logName: 'Rate Limit',
    tagTrigger: 'Rate-Limit',
    useMeta: false,
  },
  {
    filename: 'files',
    level: 'info',
    logName: 'Files',
    tagTrigger: 'Files',
    useMeta: false,
  },
  {
    filename: 'auth-error',
    level: 'warn',
    logName: 'Auth-Error',
    tagTrigger: 'Auth-Error',
    useMeta: true,
  },
  {
    filename: 'cron',
    level: 'info',
    logName: 'Cron',
    tagTrigger: 'Cron',
    useMeta: true,
  },
];
