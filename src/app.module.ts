import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ServeStaticModule, ServeStaticModuleOptions } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule, ThrottlerOptions } from '@nestjs/throttler';
import { join } from 'path';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TooledJwtModule } from './jwt/jwt.module';
import { DbModule } from './db/db.module';
import { DBQueryFilter, GlobalErrorsFilter, MulterFilter, ThrottlerLogFilter } from '@filters';
import { AuthGuard } from '@guards';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './resources/user/user/user.module';
import { LoggerModule } from './logger/logger.module';
import { CacheInterceptor, LoggingInterceptor, RecordCheckInterceptor } from '@interceptors';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule, BusinessValidationModule } from '@utils';
import { ChannelsModule } from './resources/channels/channels/channels.module';
import { MediaScanModule } from './resources/channels/scan/media-scan.module';
import { ScheduleDayModule } from './resources/schedule-day/schedule-day/schedule-day.module';
import { BroadcastModule } from './resources/broadcast/broadcast.module';
import { StreamModule } from './resources/stream/stream.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ServeStaticModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (
        configService: ConfigService,
      ): ServeStaticModuleOptions[] => [
          {
            rootPath: join(process.cwd(), 'public'),
            serveRoot: '/static',
          },
          {
            rootPath: configService.getOrThrow<string>('MEDIA_ROOT'),
            serveRoot: '/media',
            serveStaticOptions: {
              index: false,
              fallthrough: false,
            },
          },
        ],
      inject: [ConfigService],
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ThrottlerOptions[] => [
        {
          ttl: configService.get<number>('THROTTLE_TTL', 60000),
          limit: configService.get<number>('THROTTLE_LIMIT', 15),
        },
      ],
    }),
    CacheModule,
    BusinessValidationModule,
    LoggerModule,
    DbModule,
    TooledJwtModule,
    AuthModule,
    UserModule,
    ChannelsModule,
    MediaScanModule,
    ScheduleDayModule,
    BroadcastModule,
    StreamModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },

    { provide: APP_FILTER, useClass: ThrottlerLogFilter },
    { provide: APP_FILTER, useClass: DBQueryFilter },
    { provide: APP_FILTER, useClass: MulterFilter },
    { provide: APP_FILTER, useClass: GlobalErrorsFilter },

    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: CacheInterceptor },
    { provide: APP_INTERCEPTOR, useClass: RecordCheckInterceptor },
  ],
  exports: [ConfigModule, ThrottlerModule],
})
export class AppModule { }
