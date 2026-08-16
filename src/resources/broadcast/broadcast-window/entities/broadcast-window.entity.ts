import { BroadcastTag } from '../../broadcast-tag/entities/broadcast-tag.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type BroadcastWindowKind = 'boost' | 'only_during' | 'exclude';

@Entity()
export class BroadcastWindow {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  tagId: number;

  /** Start month-day, e.g. 10-20 */
  @Column({ type: 'varchar', length: 5 })
  startMd: string;

  /** End month-day, e.g. 11-02 (may wrap year) */
  @Column({ type: 'varchar', length: 5 })
  endMd: string;

  @Column({ type: 'varchar', length: 16, default: 'boost' })
  kind: BroadcastWindowKind;

  /** Weight multiplier when kind=boost */
  @Column({ type: 'float', default: 1 })
  multiplier: number;

  @ManyToOne(() => BroadcastTag, (tag) => tag.windows, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tagId' })
  tag: BroadcastTag;
}
