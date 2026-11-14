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

/**
 * Production-like env. Existing code used `deploy`; `production` also accepted.
 */
export function isDeployEnv(
  status: string | undefined = process.env.PROJECT_STATUS,
): boolean {
  const s = (status || '').trim().toLowerCase();
  return s === 'deploy' || s === 'production';
}

/** Parse JWT TOKEN_TIME (`7d`, `24h`, …) into whole days for cookie maxAge. */
export function parseTokenTimeToDays(
  tokenTime?: string,
  fallback = 2,
): number {
  if (!tokenTime) {
    return fallback;
  }
  const m = String(tokenTime)
    .trim()
    .match(/^(\d+)\s*([dhms])$/i);
  if (!m) {
    return fallback;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  switch (m[2].toLowerCase()) {
    case 'd':
      return n;
    case 'h':
      return Math.max(1, Math.ceil(n / 24));
    case 'm':
      return Math.max(1, Math.ceil(n / (24 * 60)));
    case 's':
      return Math.max(1, Math.ceil(n / (24 * 60 * 60)));
    default:
      return fallback;
  }
}

// Prefer getCookiesDays() so value follows TOKEN_TIME after env is loaded
export const dayMs = 1000 * 60 * 60 * 24;

export function getCookiesDays(): number {
  return parseTokenTimeToDays(process.env.TOKEN_TIME, 2);
}

/** Fallback constant; cookie writers should use getCookiesDays(). */
export const cookiesDays = 2;

/**
 * Public search pagination.
 * develop: keeps page/limit -1 (unlimited).
 * deploy/production: clamps so -1 cannot dump the whole table.
 */
export function normalizePublicSearchPageOpt(
  page?: number,
  limit?: number,
): { page: number; limit: number } {
  if (!isDeployEnv()) {
    return {
      page: page && page > 0 ? page : -1,
      limit: limit && limit > 0 ? limit : -1,
    };
  }
  const maxLimit = 50;
  return {
    page: page && page > 0 ? page : 1,
    limit: limit && limit > 0 ? Math.min(limit, maxLimit) : 20,
  };
}

/** CORS origins from FRONT_URL (comma-separated). */
export function corsOriginsFromEnv(
  frontUrl: string | undefined = process.env.FRONT_URL,
): string[] {
  return (frontUrl || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const fileCleanerKey = 'fileCleaner';

export const keyWithoutLike = [
  'createdAt',
  'updatedAt',
  'slug',
  'date',
  'email',
  'username',
  'uuid',
];

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
