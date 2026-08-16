import { ChannelEpisode } from "@entities";
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { ScheduleDay } from "../../schedule-day/entities/schedule-day.entity";

export type ScheduleItemSource = 'regular' | 'special_insert' | 'holiday';

@Entity()
export class ScheduleItem {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    scheduleDayId: number;

    @Column()
    episodeId: number;

    @Column()
    order: number;

    /** Duration snapshot at schedule build time */
    @Column()
    durationSec: number;

    @Column({ type: 'varchar', length: 32, default: 'regular' })
    source: ScheduleItemSource;

    @ManyToOne(() => ScheduleDay, (scheduleDay) => scheduleDay.scheduleItems)
    @JoinColumn({ name: 'scheduleDayId' })
    scheduleDay: ScheduleDay;

    @ManyToOne(() => ChannelEpisode)
    @JoinColumn({ name: 'episodeId' })
    episode: ChannelEpisode;
}
