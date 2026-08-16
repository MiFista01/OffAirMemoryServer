import {
    Column,
    Entity,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    Unique,
} from "typeorm";
import { Channel, ScheduleItem } from "@entities";

@Entity()
@Unique(['channelId', 'date'])
export class ScheduleDay {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    channelId: number;

    @Column({ type: 'date' })
    date: string;

    /** Snapshot of channel window for that day */
    @Column({ type: 'varchar', length: 5, default: '08:00' })
    windowStart: string;

    @Column({ type: 'varchar', length: 5, default: '23:00' })
    windowEnd: string;

    @ManyToOne(() => Channel)
    @JoinColumn({ name: 'channelId' })
    channel: Channel;

    @OneToMany(() => ScheduleItem, (item) => item.scheduleDay, { cascade: true })
    scheduleItems: ScheduleItem[];
}
