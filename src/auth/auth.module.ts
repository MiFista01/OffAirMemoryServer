import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAuth } from 'src/resources/user/auth/entities/auth.entity';
import { UserAuthModule } from 'src/resources/user/auth/auth.module';
import { ProfileModule } from 'src/resources/user/profile/profile.module';

/**
 * Authentication module for managing user login and session handling
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UserAuth]),
    UserAuthModule,
    ProfileModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
