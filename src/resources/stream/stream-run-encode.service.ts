import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIR_WINDOW_START } from '@constants';
import { ChannelsService } from '../channels/channels/channels.service';
import { EpisodeService } from '../channels/episode/episode.service';
import { ScheduleItemService } from '../schedule-day/schedule-item/schedule-item.service';
import { FfmpegService } from './ffmpeg.service';
import { BusinessValidationService } from '@utils';
import {
  readAirFinish,
  writeAirFinish,
} from './air-finish.state';
import { markAirAhead } from './air-ahead.state';
import {
  calendarDateInTz,
  alignPlaylistHeadToWall,
  findPlaylistAfterCompleted,
  findRemainingPlaylist,
  isFinishingOverrun,
  isSequentialAheadOfWallClock,
  isSequentialBehindWallClock,
  isWithinAirWindow,
  msUntilScheduleItemEnd,
  msUntilScheduleOrder,
  streamFolderName,
  trimPlaylistToAirEnd,
  windowStartAt,
} from './stream-air.util';
import { join } from 'path';
import {
  clampSegmentsToFile,
  capLookahead,
  type HlsSegmentInput,
} from './stream-encode.helpers';
import type {
  StreamRunEncodeHost,
  StreamRunEncodeOpts,
} from './stream-encode.types';
import {
  streamChannelKey,
  streamJobKey,
  streamSlotFolder,
  type StreamSlot,
} from './stream-slot.util';

@Injectable()
export class StreamRunEncodeService {
  private readonly logger = new Logger(StreamRunEncodeService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly episodes: EpisodeService,
    private readonly scheduleItems: ScheduleItemService,
    private readonly ffmpeg: FfmpegService,
    private readonly businessValidation: BusinessValidationService,
  ) {}

  async runEncode(
    slug: string,
    tz: string,
    profile: string,
    append: boolean,
    align: 'wall-clock' | 'episode-start',
    opts: StreamRunEncodeOpts | undefined,
    host: StreamRunEncodeHost,
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
    const hours = host.airTimeHours();
    const folderName = streamFolderName(slug, tz, profile);
    const dir = join(streamRoot, folderName);
    const date = calendarDateInTz(tz);

    const channel = await this.channels.findOne({ slug, isActive: true });
    this.businessValidation.assertExists(channel, 'Channel not found');
    this.businessValidation.assert(channel.isActive, 'Channel is not active');

    const day = await host.loadScheduleDay(channel.id, tz);
    this.businessValidation.assertExists(day, 'No schedule for today');

    const items = day.scheduleItems ?? [];
    const airStart = windowStartAt(date, airWindowStart, tz);
    const inWindow = isWithinAirWindow(airStart, hours);
    const overrun = isFinishingOverrun(items, airStart, hours);
    const finishPending = await readAirFinish(dir);

    // Off air only if there is no overrun finish and no pending finish.
    this.businessValidation.assert(
      inWindow || overrun || !!finishPending,
      'Channel is off air',
    );

    if (finishPending && !inWindow) {
      return host.runFinishEncode(slug, tz, profile, finishPending, append);
    }

    let all = findRemainingPlaylist(items, airStart) ?? [];

    // Continuous seam (finished/skipped): next grid row, NOT wall-clock.
    // Ending-loop delay used to jump Transformers → Flapjack and skip Bakugan.
    let usedSequential = false;
    const completedIds = opts?.completedEpisodeIds ?? [];
    const seamIds =
      completedIds.length > 0
        ? completedIds
        : opts?.skipCurrent && finishPending
          ? [finishPending.episodeId]
          : [];
    if (seamIds.length) {
      const seq = findPlaylistAfterCompleted(
        items,
        seamIds,
        finishPending?.scheduleItemId,
      );
      const wall = findRemainingPlaylist(items, airStart) ?? [];
      if (seq?.length) {
        if (isSequentialBehindWallClock(seq, wall) && wall.length) {
          const gap = wall[0].item.order - seq[0].item.order;
          // Guide already left the owed slot — match F5 /start (no visible debt).
          this.logger.warn(
            `[${slug}] sequential behind wall by ${gap} slot(s) ` +
              `(owed ep=${seq[0].item.episode?.id ?? seq[0].item.episodeId}, ` +
              `guide ep=${wall[0].item.episode?.id ?? wall[0].item.episodeId}) ` +
              `— catch up to guide`,
          );
          all = wall;
          usedSequential = false;
        } else if (isSequentialAheadOfWallClock(seq, wall) && wall.length) {
          // Dual-slot standby warms the *next* row while the guide is still on
          // the current one — that looks "ahead"; holding would abort prep.
          if (opts?.asStandby) {
            this.logger.log(
              `[${slug}] standby prep ahead of guide ` +
                `(next ep=${seq[0].item.episode?.id ?? seq[0].item.episodeId}, ` +
                `guide ep=${wall[0].item.episode?.id ?? wall[0].item.episodeId}) — encode anyway`,
            );
            all = seq;
            usedSequential = true;
          } else {
            // File ended early vs durationSec — starting next now drifts air ahead of the guide.
            const waitMs = msUntilScheduleOrder(
              items,
              seq[0].item.order,
              airStart,
            );
            await host.holdForWallCatchUp(
              slug,
              tz,
              profile,
              seamIds,
              waitMs,
            );
            this.businessValidation.assert(false, 'air-grid-hold');
          }
        } else {
          const aligned = alignPlaylistHeadToWall(seq, wall);
          if (aligned[0].inpointSec > 0) {
            this.logger.log(
              `[${slug}] sequential after ep=${seamIds.join(',')} → next=${aligned[0].item.episode?.id ?? aligned[0].item.episodeId}` +
                ` +${aligned[0].inpointSec}s (wall mid-slot, ${aligned.length} left)`,
            );
          } else {
            this.logger.log(
              `[${slug}] sequential after ep=${seamIds.join(',')} → next=${aligned[0].item.episode?.id ?? aligned[0].item.episodeId} (${aligned.length} left)`,
            );
          }
          all = aligned;
          usedSequential = true;
        }
      } else if (completedIds.length) {
        const done = new Set(completedIds);
        // Wall still on a "completed" ep → we finished early; hold, don't drop into next / off.
        const wallEp =
          all[0]?.item.episode?.id ?? all[0]?.item.episodeId ?? -1;
        if (all.length && done.has(wallEp)) {
          const next = findPlaylistAfterCompleted(
            items,
            completedIds,
            finishPending?.scheduleItemId,
          );
          const waitMs = next?.length
            ? msUntilScheduleOrder(items, next[0].item.order, airStart)
            : Math.max(3_000, (all[0].durationSec || 1) * 1000);
          this.logger.log(
            `[${slug}] finished early vs guide (ep=${wallEp}) — hold ${Math.round(waitMs / 1000)}s` +
              (next?.length ? ' until next slot' : ' until slot ends'),
          );
          await host.holdForWallCatchUp(
            slug,
            tz,
            profile,
            completedIds,
            waitMs,
          );
          this.businessValidation.assert(false, 'air-grid-hold');
        }
        let dropped = 0;
        while (
          all.length &&
          done.has(all[0].item.episode?.id ?? all[0].item.episodeId ?? -1)
        ) {
          all = all.slice(1);
          dropped += 1;
        }
        if (dropped) {
          this.logger.log(
            `[${slug}] advance past ${dropped} completed episode(s) → next`,
          );
        }
        if (all.length) {
          // Keep wall mid-slot seek if guide already into the next row.
          all = alignPlaylistHeadToWall(all, wall);
        } else {
          // Last schedule row done — nothing left on wall-clock either.
          this.businessValidation.assert(false, 'Channel is off air');
        }
      } else if (!seq?.length && seamIds.length && !completedIds.length) {
        // skipCurrent on last row (no completed ids yet)
        this.businessValidation.assert(false, 'Channel is off air');
      }
    }

    if (!usedSequential && opts?.skipCurrent && all.length > 1) {
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
    } else if (!usedSequential && opts?.skipCurrent && all.length <= 1) {
      this.businessValidation.assert(false, 'Channel is off air');
    }

    this.businessValidation.assertNotEmpty(all, 'Channel is off air');

    // Tail < 90s — do not encode the ending (hang + append mash).
    // If the guide is still on this slot, HOLD until it ends — skipping next early
    // is what drifts air ahead of the schedule over the day.
    const tailSkipSec = Number(this.config.get('STREAM_TAIL_SKIP_SEC', 90));
    while (
      !usedSequential &&
      all.length > 1 &&
      all[0].inpointSec > 0 &&
      all[0].durationSec < Math.max(15, tailSkipSec)
    ) {
      const wallNow = findRemainingPlaylist(items, airStart) ?? [];
      const nextTrial = [
        {
          item: all[1].item,
          inpointSec: 0,
          durationSec: all[1].item.durationSec,
        },
        ...all.slice(2).map((s) => ({
          item: s.item,
          inpointSec: 0,
          durationSec: s.item.durationSec,
        })),
      ];
      if (
        wallNow.length &&
        isSequentialAheadOfWallClock(nextTrial, wallNow)
      ) {
        const waitMs = Math.max(
          all[0].durationSec * 1000,
          msUntilScheduleOrder(items, all[1].item.order, airStart),
        );
        this.logger.log(
          `[${slug}] short tail ${all[0].durationSec}s but guide still in slot — hold ${Math.round(waitMs / 1000)}s`,
        );
        await host.holdForWallCatchUp(
          slug,
          tz,
          profile,
          [all[0].item.episode?.id ?? all[0].item.episodeId!].filter(
            (id): id is number => typeof id === 'number' && id > 0,
          ),
          waitMs,
        );
        this.businessValidation.assert(false, 'air-grid-hold');
      }
      this.logger.log(
        `[${slug}] short tail ${all[0].durationSec}s — skip to next episode`,
      );
      const nextFrom = all.slice(1).map((s, i) =>
        i === 0
          ? {
              item: s.item,
              inpointSec: 0,
              durationSec: s.item.durationSec,
            }
          : s,
      );
      all = alignPlaylistHeadToWall(
        nextFrom,
        findRemainingPlaylist(items, airStart) ?? [],
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

    // episode-start only when explicitly requested (currently nowhere on continue/reconnect).
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

    const useLookaheadCfg =
      Number.isFinite(lookaheadSec) && lookaheadSec > 0;
    // Dual-slot toggle replaces concat bridge — always encode ONE episode per ffmpeg.
    // (Legacy bridgeSeam disabled: kill+append caused 503 / A-V mix.)
    const remSec = all[0].durationSec;
    const midEpisode = all[0].inpointSec > 5;
    const lookBudget = useLookaheadCfg ? lookaheadSec : 0;
    const useLookahead = useLookaheadCfg;
    const segments = midEpisode
      ? [all[0]]
      : useLookahead
        ? capLookahead(all, lookBudget)
        : [all[0]];
    if (all.length > 1 && remSec <= 180) {
      this.logger.log(
        `[${slug}] dual-slot seam: ${Math.round(remSec)}s left on ep — ` +
          `encode solo (standby will prep next in other slot)`,
      );
    }

    // Dual-slot: never append into a live slot folder — wipe only the target slot.
    const doAppend = false;

    let hlsSegments: HlsSegmentInput[] = segments.map((seg) => {
      const ep = seg.item.episode;
      this.businessValidation.assertExists(ep, 'Episode file missing');
      return {
        path: join(mediaRoot, ...ep.relativePath.split('/')),
        inpointSec: seg.inpointSec,
        durationSec: seg.durationSec,
      };
    });

    const firstEpForClamp = segments[0].item.episode!;
    const gridDurBeforeClamp = segments[0].durationSec;
    const clamped = await clampSegmentsToFile(
      this.logger,
      hlsSegments,
      firstEpForClamp.id,
    );
    if (clamped.skipEpisodeId) {
      this.logger.warn(
        `[${slug}] seek past file end (${clamped.path}) — skip to next slot`,
      );
      await markAirAhead(dir, date, [clamped.skipEpisodeId], [
        segments[0].item.id,
      ]);
      return this.runEncode(
        slug,
        tz,
        profile,
        false,
        'wall-clock',
        {
          skipCurrent: true,
          completedEpisodeIds: [clamped.skipEpisodeId],
        },
        host,
      );
    }
    hlsSegments = clamped.segments;
    segments[0].inpointSec = hlsSegments[0].inpointSec;
    segments[0].durationSec = hlsSegments[0].durationSec;
    if (clamped.fileDurSec != null) {
      await this.syncDurationsToFile(
        slug,
        firstEpForClamp.id,
        segments[0].item.id,
        segments[0].item.durationSec,
        clamped.fileDurSec,
      );
    }
    if (Math.abs(hlsSegments[0].durationSec - gridDurBeforeClamp) > 5) {
      this.logger.warn(
        `[${slug}] grid remaining longer than file by ~${Math.round(
          gridDurBeforeClamp - hlsSegments[0].durationSec,
        )}s — clamped encode to file`,
      );
    }

    const first = segments[0];
    const firstEp = first.item.episode;
    const firstPath = hlsSegments[0].path;
    const encodedEpisodeIds = segments
      .map((s) => s.item.episode?.id)
      .filter((id): id is number => typeof id === 'number');
    const remainingAtStart = first.durationSec;
    const encodeStartedAt = Date.now();

    // Air cursor: always write — continuous debt until this cartoon ends.
    const prevCursor = await readAirFinish(dir);
    const seamGen =
      prevCursor && prevCursor.episodeId !== firstEp.id
        ? (prevCursor.generation ?? 0) + 1
        : (prevCursor?.generation ?? 1);
    if (opts?.completedEpisodeIds?.length && !opts?.asStandby) {
      await markAirAhead(
        dir,
        date,
        opts.completedEpisodeIds,
        undefined,
      );
      // Catch-up / /start often call runEncode directly (not continueEncode) —
      // without this, Titan/Saturdays replay the same ep the next day.
      void host.recordFinishedEpisodes?.(
        channel.id,
        date,
        opts.completedEpisodeIds,
      );
    }
    // Standby must NOT rewrite air-finish onto the next episode while A is still live.
    if (!opts?.asStandby) {
      await writeAirFinish(dir, {
        date,
        episodeId: firstEp.id,
        scheduleItemId: first.item.id,
        mediaPath: firstPath,
        relativePath: firstEp.relativePath,
        inpointSec: first.inpointSec,
        durationSec: first.durationSec,
        source: first.item.source ?? 'regular',
        policy: 'continuous',
        generation: seamGen,
        savedAt: new Date().toISOString(),
      });
    }

    const channelKey = streamChannelKey(slug, tz, profile);
    const asStandby = !!opts?.asStandby;
    let slot: StreamSlot =
      opts?.targetSlot ??
      (asStandby
        ? this.ffmpeg.nextStandbySlot(channelKey)
        : this.ffmpeg.getActiveSlot(channelKey));
    if (!asStandby && !opts?.targetSlot) {
      // Cold / primary encode — prefer active; if none alive, reset to a.
      const activeJob = this.ffmpeg.getActive(channelKey);
      if (!activeJob || !this.ffmpeg.isJobAlive(activeJob)) {
        slot = 'a';
        this.ffmpeg.setActiveSlot(channelKey, 'a');
      }
    }
    if (asStandby) {
      this.ffmpeg.setStandbySlot(channelKey, slot);
    } else {
      this.ffmpeg.setActiveSlot(channelKey, slot);
      // Keep warming standby unless primary is taking that same slot.
      const sb = this.ffmpeg.getStandbySlot(channelKey);
      if (sb === slot) this.ffmpeg.setStandbySlot(channelKey, undefined);
    }

    const slotFolder = streamSlotFolder(slug, tz, profile, slot);
    const jobKey = streamJobKey(slug, tz, profile, slot);

    /** Runtime role — closures capture asStandby at spawn; after promote role flips. */
    const jobRole = (): 'standby' | 'active' | 'retired' => {
      const sb = this.ffmpeg.getStandbySlot(channelKey);
      if (sb && slot === sb) return 'standby';
      if (this.ffmpeg.getActiveSlot(channelKey) === slot) return 'active';
      return 'retired';
    };

    // Dual-slot: always arm standby prep; callback no-ops while this job is still standby.
    const job = await this.ffmpeg.startHls({
      key: jobKey,
      streamRoot,
      folderName: slotFolder,
      segments: hlsSegments,
      append: doAppend,
      rollingHandoff: false,
      slot,
      channelKey,
      onStandbyPrep: () => {
        if (jobRole() !== 'active') return;
        if (this.ffmpeg.getStandbySlot(channelKey)) return;
        const epId = firstEp?.id;
        if (!epId) return;
        void host.spawnStandby?.(slug, tz, profile, {
          completedEpisodeIds: [epId],
        });
      },
      onNaturalEnd: ({ rolling }) => {
        const role = jobRole();
        if (role === 'standby') {
          // Standby finished/crashed while A still live — clear flag, do NOT skip air.
          this.logger.warn(
            `[${slug}] standby slot=${slot} ended (rolling=${rolling}) — clear, keep active`,
          );
          this.ffmpeg.setStandbySlot(channelKey, undefined);
          return;
        }
        if (role === 'retired') return;
        if (rolling) {
          void host.continueEncode(slug, tz, profile, {
            resumeCursor: true,
            rolling: true,
          });
          return;
        }
        const standby = this.ffmpeg.getStandbySlot(channelKey);
        const standbyJob = standby
          ? this.ffmpeg.getBySlot(channelKey, standby)
          : undefined;
        if (
          standbyJob &&
          this.ffmpeg.isJobAlive(standbyJob) &&
          standbyJob.ready
        ) {
          void host.promoteStandby?.(slug, tz, profile);
          return;
        }
        void host.continueEncode(slug, tz, profile, {
          completedEpisodeIds: firstEp?.id ? [firstEp.id] : encodedEpisodeIds,
        });
      },
      onStallEnd: () => {
        const role = jobRole();
        if (role === 'standby') {
          this.logger.warn(
            `[${slug}] standby slot=${slot} stall — clear, keep active`,
          );
          this.ffmpeg.setStandbySlot(channelKey, undefined);
          return;
        }
        if (role === 'retired') return;
        const elapsed = (Date.now() - encodeStartedAt) / 1000;
        const solo = hlsSegments.length === 1;
        const shortTail = remainingAtStart <= 90;
        const left = Math.max(0, remainingAtStart - elapsed);
        // Only the last ~20s — 90s was cutting Rick/Morty post-credits (~30s early).
        const nearEof = left <= 20;
        if (elapsed < 45 && !shortTail && !nearEof) {
          this.logger.warn(
            `[${slug}] stall during startup/seek (${Math.round(elapsed)}s) — retry same`,
          );
          void host.continueEncode(slug, tz, profile, {
            resumeCursor: true,
            rolling: true,
          });
          return;
        }
        const nearEnd =
          shortTail ||
          nearEof ||
          elapsed >= Math.max(0, remainingAtStart - 20);
        if (nearEnd) {
          void (async () => {
            // Credits / post-credits often look like a stall — do not skip while
            // the guide is still in this slot (Rick stinger → early Primal).
            const past = first.item.id
              ? await host.guidePastScheduleItem?.(slug, tz, first.item.id)
              : true;
            if (past === false) {
              this.logger.warn(
                `[${slug}] near-EOF stall but guide still in slot — resume (keep ending)`,
              );
              void host.continueEncode(slug, tz, profile, {
                resumeCursor: true,
                rolling: true,
              });
              return;
            }
            this.logger.warn(
              `[${slug}] near-EOF stall (${Math.round(elapsed)}s / ${Math.round(left)}s left` +
                `${solo ? ', solo' : ''}) — advance`,
            );
            void host.continueEncode(slug, tz, profile, {
              skipCurrent: true,
              completedEpisodeIds: firstEp?.id ? [firstEp.id] : undefined,
            });
          })();
          return;
        }
        this.logger.warn(
          `[${slug}] mid-episode stall (${Math.round(elapsed)}s / ${Math.round(left)}s left) — resume`,
        );
        void host.continueEncode(slug, tz, profile, {
          resumeCursor: true,
          rolling: true,
        });
      },
    });

    job.episodeId = firstEp.id;
    job.scheduleItemId = first.item.id;
    job.offsetSec = first.inpointSec;
    job.source = first.item.source;
    job.remainingCount = all.length;
    job.mediaPath = firstPath;
    job.relativePath = firstEp.relativePath;
    job.durationSec = first.durationSec;
    job.slot = slot;
    job.channelKey = channelKey;

    if (asStandby) {
      this.logger.log(
        `[${channelKey}] standby slot=${slot} ep=${firstEp.id} ready=${!!job.ready}`,
      );
      void host.watchStandbyPromote?.(slug, tz, profile);
    } else {
      // If encode overruns the grid slot, jump to guide without waiting for F5.
      const slotLeftMs = msUntilScheduleItemEnd(items, first.item.id, airStart);
      host.armSlotEndCatchUp?.(
        slug,
        tz,
        profile,
        first.item.id,
        firstEp.id,
        slotLeftMs + 750,
      );
    }

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
      slot,
    };
  }

  /**
   * Keep guide + episode.durationSec locked to the real file so wall-clock
   * and air do not drift apart over the day.
   */
  async syncDurationsToFile(
    slug: string,
    episodeId: number,
    scheduleItemId: number | undefined,
    gridSlotSec: number,
    fileDurSec: number,
  ): Promise<void> {
    const dur = Math.max(1, Math.round(fileDurSec));
    if (Math.abs(dur - gridSlotSec) <= 1) return;
    try {
      await this.episodes.update(episodeId, { durationSec: dur });
      // Do NOT rewrite live schedule_item.durationSec mid-day — that shifts
      // wall-clock and causes catch-up / skips. Item snaps on next day rebuild.
      this.logger.warn(
        `[${slug}] synced episode duration ep=${episodeId} ` +
          `grid ${gridSlotSec}s → file ${dur}s` +
          (scheduleItemId != null ? ` (item ${scheduleItemId} left for rebuild)` : ''),
      );
    } catch (e) {
      this.logger.warn(
        `[${slug}] duration sync failed ep=${episodeId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Load grid duration from DB, then sync to probed file length. */
  async syncDurationsFromProbe(
    slug: string,
    episodeId: number,
    scheduleItemId: number | undefined,
    fileDurSec: number,
  ): Promise<void> {
    let gridSlotSec = Math.round(fileDurSec);
    try {
      if (scheduleItemId != null) {
        const item = await this.scheduleItems.findOne({ id: scheduleItemId });
        if (item?.durationSec) gridSlotSec = item.durationSec;
      } else {
        const ep = await this.episodes.findOne({ id: episodeId });
        if (ep?.durationSec) gridSlotSec = ep.durationSec;
      }
    } catch {
      /* use fileDur as grid fallback */
    }
    await this.syncDurationsToFile(
      slug,
      episodeId,
      scheduleItemId,
      gridSlotSec,
      fileDurSec,
    );
  }
}
