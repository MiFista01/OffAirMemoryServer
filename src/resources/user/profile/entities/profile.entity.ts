import {
  Column,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '@entities';

@Entity()
@Unique(['userId', 'nickname'])
@Index(['nickname'])
export class UserProfile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column()
  nickname: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  avatar: string | null;

  @Column({ default: false })
  ban: boolean;

  @OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
  })
  user: User;
}
