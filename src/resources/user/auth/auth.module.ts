import { Module } from '@nestjs/common';
import { UserAuthService } from './auth.service';
import { UserAuthController } from './auth.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAuth } from './entities/auth.entity';

/**
 * User authentication module for managing user credentials and security
 *
 * Provides authentication functionality including password hashing with Argon2,
 * email verification, login tracking, and secure credential management.
 *
 * @example
 * const auth = await userAuthService.findOne({ userId: 1 });
 * const updatedAuth = await userAuthService.update(1, { password: "newPassword123!" });
 *
 * @see {@link UserAuthController} for API endpoints
 * @see {@link UserAuthService} for business logic
 * @see {@link UserAuth} entity
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserAuth])],
  controllers: [UserAuthController],
  providers: [UserAuthService],
  exports: [UserAuthService],
})
export class UserAuthModule {}
