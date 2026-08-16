import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TooledJwtService } from './jwt.service';
import { TokenBlacklist } from './entities/tokenBlacklist.entity.lite';
import { TypeOrmModule } from '@nestjs/typeorm';

/**
 * JWT module for managing JSON Web Token authentication and configuration
 *
 * Provides JWT functionality including token generation, validation, and configuration
 * management with environment-based secret keys and expiration times. Configured as
 * a global module for application-wide JWT service availability.
 *
 * @example
 * // JWT service is automatically available in all modules
 * const token = await jwtService.sign({ userId: 1 });
 * const payload = await jwtService.verify(token);
 *
 * @see {@link TooledJwtService} for tooled JWT service
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([TokenBlacklist], 'lite'),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      global: true,
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_KEY'),
        signOptions: { expiresIn: configService.get('TOKEN_TIME') },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [TooledJwtService],
  exports: [TooledJwtService],
})
export class TooledJwtModule {}
