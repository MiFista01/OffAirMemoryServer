import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { ProfileModule } from '../profile/profile.module';
import { UserAuthModule } from '../auth/auth.module';

/**
 * User resource module for managing user accounts and related data.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    ProfileModule,
    UserAuthModule,
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [
    UserService,
    ProfileModule,
    UserAuthModule,
  ],
})
export class UserModule {}
