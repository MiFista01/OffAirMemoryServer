import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { AirHistory, ChannelCartoon } from '@entities';
import { CreateAirHistoryDto } from './dto/create-air-history.dto';
import { UpdateAirHistoryDto } from './dto/update-air-history.dto';
import { EpisodeService } from '../channels/episode/episode.service';

export type RecordFinishedInput = {
  channelId: number;
  episodeId: number;
  date: string;
  source?: CreateAirHistoryDto['source'];
  scheduleItemId?: number | null;
  scheduleDayId?: number | null;
  origin?: CreateAirHistoryDto['origin'];
  finishedAt?: Date;
};

@Injectable()
export class AirHistoryService extends DefaultCRUDService<
  AirHistory,
  CreateAirHistoryDto,
  UpdateAirHistoryDto
> {
  private readonly logger = new Logger(AirHistoryService.name);

  constructor(
    @InjectRepository(AirHistory)
    airHistoryRepository: Repository<AirHistory>,
    @InjectRepository(ChannelCartoon)
    private readonly cartoons: Repository<ChannelCartoon>,
    private readonly episodes: EpisodeService,
  ) {
    super(airHistoryRepository);
  }

  /**
   * Record a fully played episode (idempotent: channel+episode+date).
   * Also advances cartoon cursor so tomorrow's grid does not re-pick the same ep.
   */
  async recordFinished(input: RecordFinishedInput): Promise<AirHistory | null> {
    const ep = await this.episodes.findOne({ id: input.episodeId });
    if (!ep) {
      this.logger.warn(`recordFinished: episode ${input.episodeId} not found`);
      return null;
    }

    const existing = await this.findOne({
      channelId: input.channelId,
      episodeId: input.episodeId,
      date: input.date,
    });
    if (existing) {
      await this.advanceCartoonCursor(ep.cartoonId, ep.seasonNumber, ep.episodeNumber);
      return existing;
    }

    try {
      const row = await this.create({
        channelId: input.channelId,
        cartoonId: ep.cartoonId,
        episodeId: input.episodeId,
        date: input.date,
        finishedAt: input.finishedAt ?? new Date(),
        source: input.source ?? 'regular',
        seasonNumber: ep.seasonNumber ?? 0,
        episodeNumber: ep.episodeNumber ?? 0,
        scheduleItemId: input.scheduleItemId ?? null,
        scheduleDayId: input.scheduleDayId ?? null,
        origin: input.origin ?? 'stream',
      });
      await this.advanceCartoonCursor(
        ep.cartoonId,
        ep.seasonNumber,
        ep.episodeNumber,
      );
      return row;
    } catch (e) {
      this.logger.warn(`recordFinished race: ${e}`);
      await this.advanceCartoonCursor(
        ep.cartoonId,
        ep.seasonNumber,
        ep.episodeNumber,
      );
      return this.findOne({
        channelId: input.channelId,
        episodeId: input.episodeId,
        date: input.date,
      });
    }
  }

  /** Move cursor forward only — never rewind mid-season. */
  private async advanceCartoonCursor(
    cartoonId: number,
    seasonNumber?: number | null,
    episodeNumber?: number | null,
  ): Promise<void> {
    const hS = seasonNumber ?? 0;
    const hE = episodeNumber ?? 0;
    const cartoon = await this.cartoons.findOne({ where: { id: cartoonId } });
    if (!cartoon) return;
    const dbS = cartoon.cursorSeason ?? 0;
    const dbE = cartoon.cursorEpisode ?? 0;
    if (dbS > hS || (dbS === hS && dbE > hE)) return;
    await this.cartoons.update(cartoonId, {
      cursorSeason: hS,
      cursorEpisode: hE,
    });
  }

  async recordFinishedMany(
    channelId: number,
    date: string,
    episodeIds: number[],
    origin: CreateAirHistoryDto['origin'] = 'stream',
  ): Promise<void> {
    const uniq = [...new Set(episodeIds.filter((id) => id > 0))];
    for (const episodeId of uniq) {
      await this.recordFinished({ channelId, episodeId, date, origin });
    }
  }

  /**
   * Before building the day: cartoon cursor = last episode from history,
   * so pickNextEpisode takes the next one. Do not touch tags/franchise.
   * Never roll DB cursor BACKWARD if history lags (dual-slot used to skip history).
   */
  applyHistoryToCursors(
    cartoons: ChannelCartoon[],
    latestByCartoon: Map<number, AirHistory>,
  ): void {
    for (const cartoon of cartoons) {
      const last = latestByCartoon.get(cartoon.id);
      if (!last) continue;
      const dbS = cartoon.cursorSeason ?? 0;
      const dbE = cartoon.cursorEpisode ?? 0;
      const hS = last.seasonNumber ?? 0;
      const hE = last.episodeNumber ?? 0;
      // Keep whichever is further along the season/episode order.
      if (dbS > hS || (dbS === hS && dbE > hE)) continue;
      cartoon.cursorSeason = hS;
      cartoon.cursorEpisode = hE;
    }
  }

  /** Furthest fully played episode per cartoonId on the channel (by S/E, not clock). */
  async latestByCartoon(
    channelId: number,
  ): Promise<Map<number, AirHistory>> {
    const rows = await this.getRepo()
      .createQueryBuilder('h')
      .where('h.channelId = :channelId', { channelId })
      .orderBy('h.finishedAt', 'DESC')
      .addOrderBy('h.id', 'DESC')
      .getMany();

    const map = new Map<number, AirHistory>();
    for (const row of rows) {
      const prev = map.get(row.cartoonId);
      if (!prev) {
        map.set(row.cartoonId, row);
        continue;
      }
      const rS = row.seasonNumber ?? 0;
      const rE = row.episodeNumber ?? 0;
      const pS = prev.seasonNumber ?? 0;
      const pE = prev.episodeNumber ?? 0;
      if (rS > pS || (rS === pS && rE > pE)) {
        map.set(row.cartoonId, row);
      }
    }
    return map;
  }
}
