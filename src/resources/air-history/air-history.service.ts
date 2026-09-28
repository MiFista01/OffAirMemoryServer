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
    private readonly episodes: EpisodeService,
  ) {
    super(airHistoryRepository);
  }

  /**
   * Записать доигранную серию (идемпотентно: channel+episode+date).
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
    if (existing) return existing;

    try {
      return await this.create({
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
    } catch (e) {
      this.logger.warn(`recordFinished race: ${e}`);
      return this.findOne({
        channelId: input.channelId,
        episodeId: input.episodeId,
        date: input.date,
      });
    }
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
   * Перед сборкой дня: курсор мульта = последняя серия из истории,
   * чтобы pickNextEpisode взял следующую. Теги/franchise не трогаем.
   */
  applyHistoryToCursors(
    cartoons: ChannelCartoon[],
    latestByCartoon: Map<number, AirHistory>,
  ): void {
    for (const cartoon of cartoons) {
      const last = latestByCartoon.get(cartoon.id);
      if (!last) continue;
      cartoon.cursorSeason = last.seasonNumber;
      cartoon.cursorEpisode = last.episodeNumber;
    }
  }

  /** Последняя доигранная серия по каждому cartoonId канала. */
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
      if (!map.has(row.cartoonId)) map.set(row.cartoonId, row);
    }
    return map;
  }
}
