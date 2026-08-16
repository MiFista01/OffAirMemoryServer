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
];

// Sync cookiesDays with TOKEN_TIME in .env to avoid auth mismatches
export const dayMs = 1000 * 60 * 60 * 24;
export const cookiesDays = 2;

export const fileCleanerKey = 'fileCleaner';

export const keyWithoutLike = ['createdAt', 'updatedAt', 'slug'];

export const tokenCookieName = 'authToken';

export const airTimeHours = 15;

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
