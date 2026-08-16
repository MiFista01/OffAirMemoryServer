import { ChannelCartoon } from "@entities";
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Channel {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    name: string;

    @Column({ unique: true })
    slug: string;

    @Column({ default: false })
    isActive: boolean;

    @OneToMany(() => ChannelCartoon, (cartoon) => cartoon.channel)
    cartoons: ChannelCartoon[];
}
