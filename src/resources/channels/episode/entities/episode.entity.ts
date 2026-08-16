import { ChannelCartoon } from "@entities";
import { BroadcastTag } from "../../../broadcast/broadcast-tag/entities/broadcast-tag.entity";
import {
    Column,
    Entity,
    JoinColumn,
    ManyToMany,
    ManyToOne,
    PrimaryGeneratedColumn,
    Unique,
} from "typeorm";

export type EpisodeKind = 'episode' | 'special';

@Entity()
@Unique(['cartoonId', 'relativePath'])
export class ChannelEpisode {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    cartoonId: number;

    /** episode = season folder; special = specials/ */
    @Column({ type: 'varchar', length: 16, default: 'episode' })
    kind: EpisodeKind;

    /** 0 for specials */
    @Column({ default: 0 })
    seasonNumber: number;

    /** 0 for specials (identity via slug/relativePath) */
    @Column({ default: 0 })
    episodeNumber: number;

    /** File-stem slug for specials; null for regular episodes */
    @Column({ type: 'varchar', length: 255, nullable: true })
    slug: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    title: string | null;

    @Column()
    relativePath: string;

    @Column({ type: 'int', nullable: true })
    durationSec: number | null;

    /** Play this special right after that regular episode */
    @Column({ type: 'int', nullable: true })
    insertAfterEpisodeId: number | null;

    @Column({ default: true })
    isActive: boolean;

    @ManyToOne(() => ChannelCartoon, (cartoon) => cartoon.episodes)
    @JoinColumn({ name: 'cartoonId' })
    cartoon: ChannelCartoon;

    @ManyToOne(() => ChannelEpisode, { nullable: true })
    @JoinColumn({ name: 'insertAfterEpisodeId' })
    insertAfterEpisode: ChannelEpisode | null;

    @ManyToMany(() => BroadcastTag, (tag) => tag.episodes)
    broadcastTags: BroadcastTag[];
}
