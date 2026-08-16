import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class TokenBlacklist {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  uuid: string;

  @Column({ default: 0 })
  countUsage: number;

  @CreateDateColumn()
  createdAt: Date;
}
