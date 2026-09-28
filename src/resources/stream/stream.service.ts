import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { AIR_TIME_HOURS, AIR_WINDOW_START, STREAM_URL_PREFIX } from '@constants';
import { ChannelsService } from '../channels/channels/channels.service';
import { ScheduleDayService } from '../schedule-day/schedule-day/schedule-day.service';
import { todayUtcDate } from '../schedule-day/schedule-day/schedule-day.builder';
import { FfmpegService } from './ffmpeg.service';
import { BusinessValidationService } from '@utils';
import {
  clearAirFinish,
  readAirFinish,
  writeAirFinish,
  type AirFinishState,
} from './air-finish.state';
import {
  calendarDateInTz,
  findRemainingPlaylist,
  isFinishingOverrun,
  isWithinAirWindow,
  parseStreamKey,
  streamFolderName,
  trimPlaylistToAirEnd,
  windowStartAt,
} from './stream-air.util';
import { access } from 'fs/promises';
import { join } from 'path';
import { AirHistoryService } from '../air-history/air-history.service';

type HlsSegmentInput = {
  path: string;
  inpointSec: number;
  durationSec: number;
};

/**
 * Приоритет конца эфира:
 * 1) Целостность текущего/последнего мульта — доиграть до конца.
 * 2) Только когда мульт реально закончился → off air + wipe HLS.
 * air-finish.json переживает рестарт Nest, пока фронт досматривает хвост.
 */
@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly scheduleDays: ScheduleDayService,
    private readonly ffmpeg: FfmpegService,
    private readonly businessValidation: BusinessValidationService,
    private readonly airHistory: AirHistoryService,
  ) {}

  async start(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);

    // 1) Живой encode — переподключаемся, НО не отдаём зависший на концовке.
    const existing = this.ffmpeg.get(key);
    if (existing && this.ffmpeg.isJobAlive(existing)) {
      const stallSec = Number(this.config.get('STREAM_STALL_SEC', 15));
      const ageMs = await this.ffmpeg.segmentAgeMs(existing.dir);
      const stalled =
        ageMs != null && ageMs >= Math.max(8, stallSec) * 1000;

      if (stalled) {
        const nearEnd = this.isJobNearEpisodeEnd(existing);
        // Посреди серии не прыгаем вперёд — только перезапуск с wall-clock/cursor.
        // У концовки — skip, иначе снова зависнем на EOF.
        this.logger.warn(
          `[${key}] /start on stalled encode (age=${Math.round((ageMs ?? 0) / 1000)}s` +
            `${nearEnd ? ', near end → skip' : ', mid → restart'})`,
        );
        this.ffmpeg.stop(key);
        // Append только если HLS ещё горячий; иначе fresh (без прыжка wall-clock).
        const append = await this.ffmpeg.isPlaylistFresh(dir);
        if (nearEnd) {
          return this.runEncode(slug, tz, profile, append, 'wall-clock', {
            skipCurrent: true,
            completedEpisodeIds: existing.episodeId
              ? [existing.episodeId]
              : undefined,
          });
        }
        return this.runEncode(slug, tz, profile, append, 'wall-clock');
      }

      existing.lastAccessAt = Date.now();
      this.ffmpeg.touch(key);
      return this.jobResponse(slug, existing);
    }

    const date = calendarDateInTz(tz);

    // 2) После рестарта Nest: продолжить тот же мульт, что кодировали
    // (не откатываться на wall-clock — skip/stall мог уйти вперёд сетки).
    const finish = await readAirFinish(dir);
    if (finish) {
      if (finish.date && finish.date !== date) {
        this.logger.log(`[${key}] stale air-finish date=${finish.date} → drop`);
        await clearAirFinish(dir);
      } else {
        const savedMs = Date.parse(finish.savedAt);
        const idleSec = Number.isFinite(savedMs)
          ? Math.max(0, (Date.now() - savedMs) / 1000)
          : Number.POSITIVE_INFINITY;
        // Свежий долг (рестарт / краткий idle) — resume.
        // Старый хвост (> длительности + 2 мин) — уже не актуален.
        if (idleSec <= finish.durationSec + 120) {
          // Хвост концовки (<90с) не переигрываем — сразу следующий.
          if (finish.durationSec < 90) {
            this.logger.log(
              `[${key}] air-finish tail ${finish.durationSec}s — skip to next`,
            );
            await clearAirFinish(dir);
            return this.runEncode(slug, tz, profile, false, 'wall-clock', {
              completedEpisodeIds: [finish.episodeId],
            });
          }
          this.logger.log(
            `[${key}] resume encode cursor episode=${finish.episodeId} +${finish.inpointSec}s (idle ${Math.round(idleSec)}s)`,
          );
          return this.runFinishEncode(slug, tz, profile, finish, true);
        }
        this.logger.log(
          `[${key}] air-finish too old (idle ${Math.round(idleSec)}s) → wall-clock`,
        );
        await clearAirFinish(dir);
      }
    }

    // Холодный старт / возврат на канал: append только к горячему HLS.
    // Иначе старый live-edge + mid-seek = «в будущее и обратно».
    const append = await this.ffmpeg.isPlaylistFresh(dir);
    return this.runEncode(slug, tz, profile, append, 'wall-clock');
  }

  stop(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    const stopped = this.ffmpeg.stop(key);
    return { channel: slug, key, stopped };
  }

  /** Heartbeat зрителя (HLS / nginx auth_request) — не даёт idle TTL убить encode. */
  heartbeat(slug: string, tz = 'Europe/Tallinn', profile = '720p') {
    const key = `${slug}:${tz}:${profile}`;
    const job = this.ffmpeg.get(key);
    if (job) {
      this.ffmpeg.touch(key);
      return { ok: true, key };
    }
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folder = streamFolderName(slug, tz, profile);
    const touched = this.ffmpeg.touchByFolder(folder);
    return { ok: touched, key, dir: join(streamRoot, folder) };
  }

  /** Перед убийством ffmpeg при рестарте Nest — зафиксировать текущий мульт. */
  async onModuleDestroy() {
    await Promise.all(
      this.ffmpeg.listJobs().map(async (job) => {
        if (!job.mediaPath || !job.episodeId || !job.durationSec) return;
        try {
          const { tz } = parseStreamKey(job.key);
          await writeAirFinish(job.dir, {
            date: calendarDateInTz(tz),
            episodeId: job.episodeId,
            mediaPath: job.mediaPath,
            relativePath: job.relativePath ?? '',
            inpointSec: job.offsetSec ?? 0,
            durationSec: job.durationSec,
            source: job.source ?? 'regular',
            savedAt: new Date().toISOString(),
          });
        } catch (e) {
          this.logger.warn(`onModuleDestroy finish save: ${e}`);
        }
      }),
    );
  }

  /** Окончательный конец эфира: стоп + wipe HLS + снять air-finish. */
  async shutdownChannelStream(
    slug: string,
    tz: string,
    profile: string,
  ): Promise<void> {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    this.logger.log(`[${key}] end of air — stop + clear HLS`);
    const job = this.ffmpeg.get(key);
    if (job) {
      await this.ffmpeg.stopAndClear(key);
    } else {
      this.ffmpeg.stop(key);
      await this.ffmpeg.clearHlsFolder(dir);
    }
    await clearAirFinish(dir);
  }

  /**
   * После конца куска encode:
   * - файл серии реально доигран → не брать её снова по wall-clock (completedEpisodeIds);
   * - в окне → следующие серии;
   * - past window + overrun → доиграть только текущий;
   * - stall past window → wipe.
   */
  private async continueEncode(
    slug: string,
    tz: string,
    profile: string,
    opts?: {
      skipCurrent?: boolean;
      /** Серии, которые ffmpeg уже полностью отдал в этом окне (code=0). */
      completedEpisodeIds?: number[];
    },
  ) {
    const key = `${slug}:${tz}:${profile}`;
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const dir = join(streamRoot, streamFolderName(slug, tz, profile));

    try {
      const airWindowStart = this.config.get<string>(
        'AIR_WINDOW_START',
        AIR_WINDOW_START,
      );
      const hours = this.airTimeHours();
      const date = calendarDateInTz(tz);
      const airStart = windowStartAt(date, airWindowStart, tz);
      const inWindow = isWithinAirWindow(airStart, hours);
      const finish = await readAirFinish(dir);

      const channel = await this.channels.findOne({ slug, isActive: true });
      const day = channel
        ? await this.loadScheduleDay(channel.id, tz)
        : null;
      const overrun = day
        ? isFinishingOverrun(day.scheduleItems, airStart, hours)
        : false;

      // История для завтрашней сетки: доигранные серии.
      if (channel && opts?.completedEpisodeIds?.length) {
        void this.airHistory
          .recordFinishedMany(
            channel.id,
            date,
            opts.completedEpisodeIds,
            'stream',
          )
          .catch((e) =>
            this.logger.warn(`[${key}] air-history record failed: ${e}`),
          );
      }

      if (inWindow) {
        // Всегда append: wipe .ts на стыке = дыра в эфире (пустое окно до первого сегмента).
        await this.runEncode(slug, tz, profile, true, 'wall-clock', {
          skipCurrent: !!opts?.skipCurrent,
          completedEpisodeIds: opts?.completedEpisodeIds,
        });
        return;
      }

      if (opts?.skipCurrent) {
        this.logger.warn(`[${key}] stall during finish → off air`);
        await this.shutdownChannelStream(slug, tz, profile);
        return;
      }

      // Доиграли файл, а сетка ещё «держит» слот → не крутить концовку снова.
      if (opts?.completedEpisodeIds?.length) {
        if (overrun) {
          const rem = day
            ? findRemainingPlaylist(day.scheduleItems, airStart)
            : null;
          const curId = rem?.[0]?.item.episode?.id;
          if (curId && opts.completedEpisodeIds.includes(curId)) {
            this.logger.log(
              `[${key}] finished overrun episode ${curId} → off air`,
            );
            await this.shutdownChannelStream(slug, tz, profile);
            return;
          }
        } else if (finish && opts.completedEpisodeIds.includes(finish.episodeId)) {
          this.logger.log(`[${key}] last cartoon completed → off air`);
          await this.shutdownChannelStream(slug, tz, profile);
          return;
        }
      }

      if (overrun) {
        this.logger.log(`[${key}] past limit — continue finishing cartoon`);
        await this.runEncode(slug, tz, profile, true, 'wall-clock', {
          onlyCurrent: true,
          persistFinish: true,
          completedEpisodeIds: opts?.completedEpisodeIds,
        });
        return;
      }

      if (finish) {
        this.logger.log(`[${key}] last cartoon completed → off air`);
        await this.shutdownChannelStream(slug, tz, profile);
        return;
      }

      await this.shutdownChannelStream(slug, tz, profile);
    } catch (e) {
      this.logger.warn(
        `[${slug}] continue ended (${e instanceof Error ? e.message : e}) — clear HLS`,
      );
      await this.shutdownChannelStream(slug, tz, profile);
    }
  }

  private airTimeHours(): number {
    const hours = Number(
      this.config.get<string | number>('AIR_TIME_HOURS', AIR_TIME_HOURS),
    );
    return Number.isFinite(hours) ? hours : AIR_TIME_HOURS;
  }

  /** Encode уже у концовки слота (durationSec на job = остаток на старте). */
  private isJobNearEpisodeEnd(job: {
    startedAt?: number;
    offsetSec?: number;
    durationSec?: number;
  }): boolean {
    const remainingAtStart = job.durationSec ?? 0;
    if (remainingAtStart <= 0) return false;
    const started = job.startedAt ?? Date.now();
    const elapsed = (Date.now() - started) / 1000;
    // Раньше ошибочно сравнивали inpoint+elapsed с remaining → всегда «near end».
    return elapsed >= Math.max(0, remainingAtStart - 60);
  }

  /**
   * Сетка дня: сначала календарь канала (tz), иначе UTC (как в schedule builder).
   * Иначе в 02:00 Tallinn берётся вчерашний UTC-день и seek/таймауты плывут.
   */
  private async loadScheduleDay(channelId: number, tz: string) {
    const localDate = calendarDateInTz(tz);
    const relations = ['scheduleItems', 'scheduleItems.episode'] as const;
    let day = await this.scheduleDays.findOne(
      { channelId, date: localDate },
      [...relations],
    );
    if (!day) {
      const utcDate = todayUtcDate();
      if (utcDate !== localDate) {
        day = await this.scheduleDays.findOne(
          { channelId, date: utcDate },
          [...relations],
        );
      }
    }
    return day;
  }

  /**
   * Таймер не важнее целостности мульта:
   * живой encode и air-finish.json не трогаем.
   */
  @Interval(60_000)
  async enforceAirWindow() {
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const hours = this.airTimeHours();
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();

    for (const job of this.ffmpeg.listJobs()) {
      try {
        const { slug, tz, profile } = parseStreamKey(job.key);
        const date = calendarDateInTz(tz);
        const airStart = windowStartAt(date, airWindowStart, tz);
        if (isWithinAirWindow(airStart, hours)) continue;

        const dir = join(streamRoot, streamFolderName(slug, tz, profile));

        if (this.ffmpeg.isJobAlive(job)) {
          await this.ensureFinishFromJob(job, dir, date);
          this.logger.log(
            `[${job.key}] past limit — priority: finish current cartoon`,
          );
          continue;
        }

        const finish = await readAirFinish(dir);
        if (finish) {
          this.logger.log(
            `[${job.key}] past limit — air-finish pending, wait for /start`,
          );
          continue;
        }

        await this.shutdownChannelStream(slug, tz, profile);
      } catch (e) {
        this.logger.warn(`enforceAirWindow: ${e}`);
      }
    }
  }

  private async ensureFinishFromJob(
    job: {
      episodeId?: number;
      offsetSec?: number;
      source?: string;
      mediaPath?: string;
      relativePath?: string;
      durationSec?: number;
    },
    dir: string,
    date?: string,
  ): Promise<void> {
    if (await readAirFinish(dir)) return;
    if (!job.mediaPath || !job.episodeId || !job.durationSec) return;
    await writeAirFinish(dir, {
      date: date ?? calendarDateInTz('Europe/Tallinn'),
      episodeId: job.episodeId,
      mediaPath: job.mediaPath,
      relativePath: job.relativePath ?? '',
      inpointSec: job.offsetSec ?? 0,
      durationSec: job.durationSec,
      source: job.source ?? 'regular',
      savedAt: new Date().toISOString(),
    });
  }

  /** Resume после рестарта: только этот файл до конца. */
  private async runFinishEncode(
    slug: string,
    tz: string,
    profile: string,
    finish: AirFinishState,
    append: boolean,
  ) {
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const key = `${slug}:${tz}:${profile}`;
    const date = calendarDateInTz(tz);

    let inpoint = finish.inpointSec;
    let duration = finish.durationSec;

    // Пока Nest лежал, фронт мог досмотреть буфер — сдвигаем inpoint вперёд.
    const savedMs = Date.parse(finish.savedAt);
    if (Number.isFinite(savedMs)) {
      const idleSec = Math.max(0, Math.floor((Date.now() - savedMs) / 1000));
      if (idleSec > 0 && idleSec < duration) {
        inpoint += idleSec;
        duration -= idleSec;
      } else if (idleSec >= duration) {
        const airWindowStart = this.config.get<string>(
          'AIR_WINDOW_START',
          AIR_WINDOW_START,
        );
        const hours = this.airTimeHours();
        const airStart = windowStartAt(date, airWindowStart, tz);
        if (isWithinAirWindow(airStart, hours)) {
          this.logger.log(
            `[${key}] air-finish elapsed during downtime → next episode`,
          );
          await clearAirFinish(dir);
          return this.runEncode(slug, tz, profile, false, 'wall-clock', {
            completedEpisodeIds: [finish.episodeId],
          });
        }
        this.logger.log(
          `[${key}] air-finish already elapsed during downtime → off air`,
        );
        await this.shutdownChannelStream(slug, tz, profile);
        this.businessValidation.assert(false, 'Channel is off air');
      }
    }

    // Уже у концовки — не переигрывать титры.
    if (duration < 90) {
      this.logger.log(
        `[${key}] finish remaining ${duration}s — skip to next`,
      );
      await clearAirFinish(dir);
      return this.runEncode(slug, tz, profile, false, 'wall-clock', {
        completedEpisodeIds: [finish.episodeId],
      });
    }

    try {
      const airWindowStart = this.config.get<string>(
        'AIR_WINDOW_START',
        AIR_WINDOW_START,
      );
      const channel = await this.channels.findOne({ slug, isActive: true });
      if (channel) {
        const day = await this.loadScheduleDay(channel.id, tz);
        const airStart = windowStartAt(date, airWindowStart, tz);
        const rem = day
          ? findRemainingPlaylist(day.scheduleItems, airStart)
          : null;
        if (
          rem?.[0]?.item.episode?.id === finish.episodeId &&
          rem[0].inpointSec > inpoint
        ) {
          inpoint = rem[0].inpointSec;
          duration = rem[0].durationSec;
        }
      }
    } catch {
      /* keep saved */
    }

    const remain = Math.max(1, duration);
    const updated: AirFinishState = {
      ...finish,
      date: finish.date || date,
      inpointSec: inpoint,
      durationSec: remain,
    };
    await writeAirFinish(dir, updated);

    const segments: HlsSegmentInput[] = [
      {
        path: finish.mediaPath,
        inpointSec: updated.inpointSec,
        durationSec: updated.durationSec,
      },
    ];
    const encodeStartedAt = Date.now();
    const remainingAtStart = updated.durationSec;

    const job = await this.ffmpeg.startHls({
      key,
      streamRoot,
      folderName,
      segments,
      // Resume тоже с append, если playlist жив — иначе дыра на стыке.
      append: true,
      rollingHandoff: false,
      onNaturalEnd: ({ rolling }) => {
        void this.continueEncode(slug, tz, profile, {
          completedEpisodeIds: rolling ? undefined : [finish.episodeId],
        });
      },
      onStallEnd: () => {
        const elapsed = (Date.now() - encodeStartedAt) / 1000;
        if (elapsed < 45) {
          this.logger.warn(
            `[${key}] finish stall during seek (${Math.round(elapsed)}s) — retry`,
          );
          void this.continueEncode(slug, tz, profile);
          return;
        }
        const nearEnd = elapsed >= Math.max(0, remainingAtStart - 60);
        void this.continueEncode(slug, tz, profile, {
          skipCurrent: nearEnd,
          completedEpisodeIds: nearEnd ? [finish.episodeId] : undefined,
        });
      },
    });

    job.episodeId = finish.episodeId;
    job.offsetSec = updated.inpointSec;
    job.source = finish.source;
    job.remainingCount = 1;
    job.mediaPath = finish.mediaPath;
    job.relativePath = finish.relativePath;
    job.durationSec = updated.durationSec;

    return this.jobResponse(slug, job);
  }

  private async runEncode(
    slug: string,
    tz: string,
    profile: string,
    append: boolean,
    align: 'wall-clock' | 'episode-start',
    opts?: {
      skipCurrent?: boolean;
      onlyCurrent?: boolean;
      persistFinish?: boolean;
      completedEpisodeIds?: number[];
    },
  ) {
    const mediaRoot = this.config.getOrThrow<string>('MEDIA_ROOT').trim();
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const lookaheadSec = Number(
      this.config.get<string | number>('STREAM_LOOKAHEAD_SEC', 0),
    );
    const hours = this.airTimeHours();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const date = calendarDateInTz(tz);

    const channel = await this.channels.findOne({ slug, isActive: true });
    this.businessValidation.assertExists(channel, 'Channel not found');
    this.businessValidation.assert(channel.isActive, 'Channel is not active');

    const day = await this.loadScheduleDay(channel.id, tz);
    this.businessValidation.assertExists(day, 'No schedule for today');

    const airStart = windowStartAt(date, airWindowStart, tz);
    const inWindow = isWithinAirWindow(airStart, hours);
    const overrun = isFinishingOverrun(day.scheduleItems, airStart, hours);
    const finishPending = await readAirFinish(dir);

    // Off air только если нет доигровки и нет pending finish.
    this.businessValidation.assert(
      inWindow || overrun || !!finishPending,
      'Channel is off air',
    );

    if (finishPending && !inWindow) {
      return this.runFinishEncode(slug, tz, profile, finishPending, append);
    }

    let all = findRemainingPlaylist(day.scheduleItems, airStart);
    this.businessValidation.assertNotEmpty(all, 'Channel is off air');

    // Файл уже доигран, а сетка ещё указывает на него (duration в БД > файла) —
    // иначе концовка крутится 2–3 раза подряд.
    if (opts?.completedEpisodeIds?.length) {
      const done = new Set(opts.completedEpisodeIds);
      let dropped = 0;
      while (all.length && done.has(all[0].item.episode?.id ?? -1)) {
        all = all.slice(1);
        dropped += 1;
      }
      if (dropped) {
        this.logger.log(
          `[${slug}] advance past ${dropped} completed episode(s) → next`,
        );
      }
      if (all.length) {
        all = all.map((s, i) =>
          i === 0
            ? {
                item: s.item,
                inpointSec: 0,
                durationSec: s.item.durationSec,
              }
            : s,
        );
      }
    }

    if (opts?.skipCurrent && all.length > 1) {
      this.logger.warn(`[${slug}] stall skip current episode → next`);
      all = all.slice(1).map((s, i) =>
        i === 0
          ? {
              item: s.item,
              inpointSec: 0,
              durationSec: s.item.durationSec,
            }
          : s,
      );
    } else if (opts?.skipCurrent) {
      this.businessValidation.assert(false, 'Channel is off air');
    }

    // Хвост < 90с — не кодируем концовку (hang + append-каша). Сразу следующий.
    const tailSkipSec = Number(this.config.get('STREAM_TAIL_SKIP_SEC', 90));
    let droppedTail = false;
    while (
      all.length > 1 &&
      all[0].inpointSec > 0 &&
      all[0].durationSec < Math.max(15, tailSkipSec)
    ) {
      this.logger.log(
        `[${slug}] short tail ${all[0].durationSec}s — skip to next episode`,
      );
      droppedTail = true;
      all = all.slice(1).map((s, i) =>
        i === 0
          ? {
              item: s.item,
              inpointSec: 0,
              durationSec: s.item.durationSec,
            }
          : s,
      );
    }

    this.businessValidation.assertNotEmpty(all, 'Channel is off air');

    all = trimPlaylistToAirEnd(all, hours, airStart);
    this.businessValidation.assertNotEmpty(all, 'Channel is off air');

    const finishing =
      opts?.onlyCurrent || opts?.persistFinish || (overrun && !inWindow);
    if (finishing) {
      all = [all[0]];
    }

    // episode-start только если явно просили (сейчас нигде на continue/reconnect).
    if (align === 'episode-start' && all[0].inpointSec > 0) {
      const cur = all[0];
      all = [
        {
          item: cur.item,
          inpointSec: 0,
          durationSec: cur.item.durationSec,
        },
        ...all.slice(1),
      ];
    }

    const useLookahead =
      Number.isFinite(lookaheadSec) && lookaheadSec > 0;
    // Mid-episode: только текущий файл (fast -ss).
    const midEpisode = all[0].inpointSec > 5;
    const segments = midEpisode
      ? [all[0]]
      : useLookahead
        ? this.capLookahead(all, lookaheadSec)
        : all;

    // Append держим на стыках серий — иначе clear .ts → чёрный экран/пауза.
    // «Каша концовки» лечится completedEpisodeIds, не wipe папки.
    const doAppend = append;

    const hlsSegments: HlsSegmentInput[] = segments.map((seg) => {
      const ep = seg.item.episode;
      this.businessValidation.assertExists(ep, 'Episode file missing');
      return {
        path: join(mediaRoot, ...ep.relativePath.split('/')),
        inpointSec: seg.inpointSec,
        durationSec: seg.durationSec,
      };
    });

    const first = segments[0];
    const firstEp = first.item.episode;
    const firstPath = hlsSegments[0].path;
    const encodedEpisodeIds = segments
      .map((s) => s.item.episode?.id)
      .filter((id): id is number => typeof id === 'number');
    const remainingAtStart = first.durationSec;
    const encodeStartedAt = Date.now();

    // Курсор эфира: всегда пишем — после рестарта Nest не откатываемся по wall-clock.
    await writeAirFinish(dir, {
      date,
      episodeId: firstEp.id,
      mediaPath: firstPath,
      relativePath: firstEp.relativePath,
      inpointSec: first.inpointSec,
      durationSec: first.durationSec,
      source: first.item.source ?? 'regular',
      savedAt: new Date().toISOString(),
    });

    const key = `${slug}:${tz}:${profile}`;
    const job = await this.ffmpeg.startHls({
      key,
      streamRoot,
      folderName,
      segments: hlsSegments,
      append: doAppend,
      rollingHandoff: useLookahead && !midEpisode,
      onNaturalEnd: ({ rolling }) => {
        void this.continueEncode(slug, tz, profile, {
          // Окно из одной серии доиграно → всегда помечаем completed.
          completedEpisodeIds: rolling
            ? undefined
            : encodedEpisodeIds,
        });
      },
      onStallEnd: () => {
        const elapsed = (Date.now() - encodeStartedAt) / 1000;
        if (elapsed < 45) {
          this.logger.warn(
            `[${slug}] stall during startup/seek (${Math.round(elapsed)}s) — retry same`,
          );
          void this.continueEncode(slug, tz, profile);
          return;
        }
        // Solo/fastSeek: stall после seek ≈ EOF/титры (файл короче сетки).
        const solo = hlsSegments.length === 1;
        const nearEnd =
          solo || elapsed >= Math.max(0, remainingAtStart - 60);
        void this.continueEncode(slug, tz, profile, {
          skipCurrent: nearEnd,
          completedEpisodeIds:
            nearEnd && firstEp?.id ? [firstEp.id] : undefined,
        });
      },
    });

    job.episodeId = firstEp.id;
    job.offsetSec = first.inpointSec;
    job.source = first.item.source;
    job.remainingCount = all.length;
    job.mediaPath = firstPath;
    job.relativePath = firstEp.relativePath;
    job.durationSec = first.durationSec;

    return {
      channel: slug,
      streamUrl: job.ready ? job.playlistUrl : null,
      episodeId: firstEp.id,
      offsetSec: first.inpointSec,
      source: first.item.source,
      remainingCount: all.length,
      encodeWindowSec: segments.reduce((s, x) => s + x.durationSec, 0),
      airWindowStart,
      ready: !!job.ready,
      playable: !!job.ready,
      status: job.ready ? ('live' as const) : ('starting' as const),
      pollAfterMs: job.ready ? undefined : 2000,
      message: job.ready
        ? undefined
        : 'Эфир есть, подготавливаем поток — подождите несколько секунд',
    };
  }

  /**
   * Готов ли HLS. Лёгкий поллинг (~2с).
   * ensure=true — если эфир есть, а encode ещё нет (типично после рестарта Nest /
   * смены канала), поднять через /start и вернуть starting|live.
   * status: live | starting | idle | off
   */
  async status(
    slug: string,
    tz = 'Europe/Tallinn',
    profile = '720p',
    ensure = false,
  ) {
    const key = `${slug}:${tz}:${profile}`;
    const job = this.ffmpeg.get(key);
    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const streamUrl =
      job?.playlistUrl ?? `${STREAM_URL_PREFIX}/${folderName}/playlist.m3u8`;

    let hasPlaylist = false;
    try {
      await access(join(dir, 'playlist.m3u8'));
      hasPlaylist = true;
    } catch {
      hasPlaylist = false;
    }
    const ageMs = hasPlaylist ? await this.ffmpeg.segmentAgeMs(dir) : null;
    const alive = !!(job && this.ffmpeg.isJobAlive(job));
    let ready =
      !!job?.ready ||
      (alive && ageMs != null && ageMs < 30_000) ||
      (!!hasPlaylist && ageMs != null && ageMs < 15_000);

    if (job && ready && !job.ready) job.ready = true;

    if (ready) {
      return {
        channel: slug,
        key,
        alive,
        ready: true,
        playable: true,
        status: 'live' as const,
        streamUrl,
        ageSec: ageMs != null ? Math.round(ageMs / 1000) : null,
        pollAfterMs: undefined as number | undefined,
        message: undefined as string | undefined,
      };
    }

    if (alive) {
      return {
        channel: slug,
        key,
        alive: true,
        ready: false,
        playable: false,
        status: 'starting' as const,
        // URL ещё нельзя кормить в hls.js — будет лавина 404.
        streamUrl: null as string | null,
        ageSec: ageMs != null ? Math.round(ageMs / 1000) : null,
        pollAfterMs: 2000,
        message: 'Эфир есть, подготавливаем поток — подождите',
      };
    }

    // Нет job: либо ещё не стартовали (после рестарта / смены канала), либо off air.
    const onAir = await this.isChannelOnAir(slug, tz, profile);
    if (!onAir) {
      return {
        channel: slug,
        key,
        alive: false,
        ready: false,
        playable: false,
        status: 'off' as const,
        streamUrl: null as string | null,
        ageSec: null as number | null,
        pollAfterMs: undefined as number | undefined,
        message: 'Сейчас не в эфире',
      };
    }

    if (ensure) {
      try {
        const started = await this.start(slug, tz, profile);
        const startedReady = !!started.ready;
        return {
          channel: slug,
          key,
          alive: true,
          ready: startedReady,
          playable: startedReady,
          status: startedReady ? ('live' as const) : ('starting' as const),
          streamUrl: startedReady ? started.streamUrl : null,
          ageSec: null as number | null,
          pollAfterMs: startedReady ? undefined : 2000,
          message: started.message,
        };
      } catch (e) {
        this.logger.warn(`[${key}] status ensure start failed: ${e}`);
        return {
          channel: slug,
          key,
          alive: false,
          ready: false,
          playable: false,
          status: 'off' as const,
          streamUrl: null as string | null,
          ageSec: null as number | null,
          pollAfterMs: undefined as number | undefined,
          message: 'Сейчас не в эфире',
        };
      }
    }

    return {
      channel: slug,
      key,
      alive: false,
      ready: false,
      playable: false,
      status: 'idle' as const,
      streamUrl: null as string | null,
      ageSec: null as number | null,
      pollAfterMs: 2000,
      message:
        'Эфир есть, поток ещё не запущен — подождите или вызовите /start',
    };
  }

  /** В окне эфира / overrun / air-finish — можно поднимать encode. */
  private async isChannelOnAir(
    slug: string,
    tz: string,
    profile: string,
  ): Promise<boolean> {
    const channel = await this.channels.findOne({ slug, isActive: true });
    if (!channel?.isActive) return false;

    const airWindowStart = this.config.get<string>(
      'AIR_WINDOW_START',
      AIR_WINDOW_START,
    );
    const hours = this.airTimeHours();
    const date = calendarDateInTz(tz);
    const airStart = windowStartAt(date, airWindowStart, tz);
    if (isWithinAirWindow(airStart, hours)) return true;

    const day = await this.loadScheduleDay(channel.id, tz);
    if (day && isFinishingOverrun(day.scheduleItems, airStart, hours)) {
      return true;
    }

    const streamRoot = this.config.getOrThrow<string>('STREAM_ROOT').trim();
    const finish = await readAirFinish(
      join(streamRoot, streamFolderName(slug, tz, profile)),
    );
    return !!finish;
  }

  private jobResponse(
    slug: string,
    job: {
      playlistUrl: string;
      episodeId?: number;
      offsetSec?: number;
      source?: string;
      remainingCount?: number;
      ready?: boolean;
    },
  ) {
    const ready = !!job.ready;
    return {
      channel: slug,
      streamUrl: ready ? job.playlistUrl : null,
      episodeId: job.episodeId ?? 0,
      offsetSec: job.offsetSec ?? 0,
      source: job.source ?? 'regular',
      remainingCount: job.remainingCount ?? 0,
      encodeWindowSec: 0,
      airWindowStart: this.config.get<string>(
        'AIR_WINDOW_START',
        AIR_WINDOW_START,
      ),
      ready,
      playable: ready,
      status: ready ? ('live' as const) : ('starting' as const),
      pollAfterMs: ready ? undefined : 2000,
      message: ready
        ? undefined
        : 'Эфир есть, подготавливаем поток — подождите несколько секунд',
    };
  }

  private capLookahead<T extends { durationSec: number }>(
    segments: T[],
    maxSec: number,
  ): T[] {
    const out: T[] = [];
    let acc = 0;
    for (const seg of segments) {
      out.push(seg);
      acc += seg.durationSec;
      if (acc >= maxSec) break;
    }
    return out;
  }
}
