import { Channel, ChannelCartoon, ChannelEpisode } from '@entities';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type AirHistoryOrigin = 'stream' | 'reconcile';
export type AirHistorySource = 'regular' | 'special_insert' | 'holiday';

/**
 * Record of a fully played episode — for building the next day (cursor / chronology).
 * Does not drive the live stream.
 */
@Entity()
@Unique(['channelId', 'episodeId', 'date'])
@Index(['channelId', 'cartoonId', 'finishedAt'])
export class AirHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  channelId: number;

  @Column()
  cartoonId: number;

  @Column()
  episodeId: number;

  /** Calendar air day YYYY-MM-DD (same as ScheduleDay.date) */
  @Column({ type: 'date' })
  date: string;

  @Column({ type: 'datetime' })
  finishedAt: Date;

  @Column({ type: 'varchar', length: 32, default: 'regular' })
  source: AirHistorySource;

  @Column({ type: 'int', default: 0 })
  seasonNumber: number;

  @Column({ type: 'int', default: 0 })
  episodeNumber: number;

  @Column({ type: 'int', nullable: true })
  scheduleItemId: number | null;

  @Column({ type: 'int', nullable: true })
  scheduleDayId: number | null;

  @Column({ type: 'varchar', length: 16, default: 'stream' })
  origin: AirHistoryOrigin;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel: Channel;

  @ManyToOne(() => ChannelCartoon, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cartoonId' })
  cartoon: ChannelCartoon;

  @ManyToOne(() => ChannelEpisode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'episodeId' })
  episode: ChannelEpisode;
}
