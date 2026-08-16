import { BroadcastWindow, ChannelCartoon, ChannelEpisode } from '@entities';
import {
  Column,
  Entity,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class BroadcastTag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @ManyToMany(() => ChannelCartoon, (cartoon) => cartoon.broadcastTags)
  @JoinTable({
    name: 'broadcast_cartoon_tag',
    joinColumn: { name: 'tagId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'cartoonId', referencedColumnName: 'id' },
  })
  cartoons: ChannelCartoon[];

  @ManyToMany(() => ChannelEpisode, (episode) => episode.broadcastTags)
  @JoinTable({
    name: 'broadcast_episode_tag',
    joinColumn: { name: 'tagId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'episodeId', referencedColumnName: 'id' },
  })
  episodes: ChannelEpisode[];

  @OneToMany(() => BroadcastWindow, (window) => window.tag)
  windows: BroadcastWindow[];
}
