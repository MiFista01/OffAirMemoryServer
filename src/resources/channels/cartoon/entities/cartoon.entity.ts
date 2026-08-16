import { Channel, ChannelEpisode } from "@entities";
import { BroadcastTag } from "../../../broadcast/broadcast-tag/entities/broadcast-tag.entity";
import {
    Column,
    Entity,
    JoinColumn,
    ManyToMany,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    Unique,
} from "typeorm";

@Entity()
@Unique(['channelId', 'slug'])
export class ChannelCartoon {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    channelId: number;

    @Column()
    name: string;

    @Column()
    slug: string;

    @Column({ default: false })
    isActive: boolean;

    /** Roulette weight for schedule random */
    @Column({ type: 'float', default: 1 })
    weight: number;

    /** Shared franchise key, e.g. ben-10 */
    @Column({ type: 'varchar', length: 64, nullable: true })
    franchiseKey: string | null;

    /** Order inside franchise (OS=1, AF=2, …) */
    @Column({ type: 'int', nullable: true })
    eraOrder: number | null;

    /** Last regular episode put on air (chronology cursor) */
    @Column({ type: 'int', default: 0 })
    cursorSeason: number;

    @Column({ type: 'int', default: 0 })
    cursorEpisode: number;

    @ManyToOne(() => Channel, (channel) => channel.cartoons)
    @JoinColumn({ name: 'channelId' })
    channel: Channel;

    @OneToMany(() => ChannelEpisode, (episode) => episode.cartoon)
    episodes: ChannelEpisode[];

    @ManyToMany(() => BroadcastTag, (tag) => tag.cartoons)
    broadcastTags: BroadcastTag[];
}
