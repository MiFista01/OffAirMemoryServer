import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as dotenv from 'dotenv';
import { BackupService } from './backup/backup.service';
import * as entities from '@entities';
import * as entitiesLite from '@entities-lite';
import { isDeployEnv } from '@constants';

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
      const deploy = isDeployEnv(configService.get<string>('PROJECT_STATUS'));
      return {
        type: 'mariadb' as const,
        host: configService.get<string>('DB_HOST'),
        port: Number(configService.get<string | number>('DB_PORT', 3306)),
        username: configService.get<string>('DB_USER'),
        password: configService.get<string>('DB_PASS') ?? '',
        database,
        entities: [...Object.values(entities)],
        // Soft: sync in develop; never auto-mutate schema in deploy/production.
        // Does NOT create the database itself — run CREATE DATABASE first.
        synchronize: !deploy,
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
