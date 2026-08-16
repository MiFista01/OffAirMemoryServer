import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import * as argon2 from 'argon2';
import { User } from '@entities';
import { Exclude } from 'class-transformer';

@Entity()
@Index(['userId'])
@Index(['username'])
@Index(['email'])
export class UserAuth {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Exclude()
  @Column({
    update: false,
  })
  username: string;

  @Exclude()
  @Column({
    update: false,
  })
  email: string;

  @Exclude()
  @Column()
  password: string;

  // @Column({
  //   type: 'timestamp',
  //   nullable: true,
  // })
  // lastLogin: Date | null;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'UTC_TIMESTAMP()',
  })
  createdAt: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'UTC_TIMESTAMP()',
  })
  updatedAt: Date;

  @BeforeUpdate()
  @BeforeInsert()
  async hashPassword() {
    if (this.password && !this.password.startsWith('$argon2')) {
      this.password = await argon2.hash(this.password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 4,
      });
    }
  }

  @OneToOne(() => User, (user) => user.auth, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
