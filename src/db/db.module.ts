import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as dotenv from 'dotenv';
import { BackupService } from './backup/backup.service';
import * as entities from '@entities';
import * as entitiesLite from '@entities-lite';

dotenv.config();

function getDbConf(isNamed: boolean = false) {
  return {
    imports: [ConfigModule],
    inject: [ConfigService],
    name: isNamed ? 'secondary' : undefined,
    useFactory: async (configService: ConfigService) => {
      const database =
        configService.get<string>('DB_NAME') ||
        process.env.DB_NAME ||
        'off_air_memory';
      return {
        type: 'mariadb' as const,
        host: configService.get<string>('DB_HOST'),
        port: Number(configService.get<string | number>('DB_PORT', 3306)),
        username: configService.get<string>('DB_USER'),
        password: configService.get<string>('DB_PASS') ?? '',
        database,
        entities: [...Object.values(entities)],
        // Creates/updates tables on boot. Does NOT create the database itself —
        // run CREATE DATABASE off_air_memory; on MariaDB first.
        synchronize: true,
        timezone: 'Z',
        extra: {
          connectionLimit: 10,
          waitForConnections: true,
          queueLimit: 0,
          idleTimeout: 300000,
          enableKeepAlive: true,
          keepAliveInitialDelay: 0,
        },
        logging: false,
        maxQueryExecutionTime: 60000,
      };
    },
  };
}

/**
 * Database module: MariaDB (main) + SQLite (lite / JWT blacklist).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(getDbConf()),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'lite.db',
      entities: [...Object.values(entitiesLite)],
      synchronize: true,
      name: 'lite',
    }),
  ],
  providers: [BackupService],
  exports: [BackupService],
})
export class DbModule {
  constructor(private backupService: BackupService) {}

  async onModuleInit() {
    if (process.env.BACKUP_ON === 'true') {
      try {
        await this.backupService.createMariaBackup();
        await this.backupService.createSQLiteBackup('lite.db');
        await this.backupService.cleanOldBackups(10, 5);
      } catch (error) {
        console.error('Startup backup failed:', error);
      }
    }
  }
}
