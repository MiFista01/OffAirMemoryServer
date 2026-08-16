import { Inject, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger } from 'winston';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';

type BackupFile = {
  name: string;
  time: number;
};

const execAsync = promisify(exec);
@Injectable()
export class BackupService {
  private backupDir = path.join(process.cwd(), './backups');
  private backupExe: string | undefined = undefined;

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource()
    private readonly mariaDataSource: DataSource,
    @InjectDataSource('lite')
    private readonly liteDataSource: DataSource,
    @Inject(WINSTON_MODULE_PROVIDER)
    protected readonly logger: Logger,
  ) {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    this.backupExe = this.resolveBackupExe();
  }

  private resolveBackupExe(): string | undefined {
    const configured = this.configService.get<string>('BACKUP_EXE')?.trim();
    if (process.platform === 'win32') {
      return configured || 'mysqldump.exe';
    }
    if (configured && !configured.toLowerCase().endsWith('.exe')) {
      return configured;
    }
    return 'mysqldump';
  }

  async createMariaBackup(): Promise<string | null> {
    if (!this.backupExe) {
      this.logger.error('createMariaBackup: Error creating MariaDB backup', {
        tag: 'Cron',
        msg: 'Backup executable is not set',
      });
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `mariadb_backup_${timestamp}.sql`;
    const filepath = path.join(this.backupDir, filename);

    const options = this.mariaDataSource.options as any;
    const { host, port, username, password, database } = options;

    try {
      const configPath = path.join(process.cwd(), '.backup.cnf');
      const command = `"${this.backupExe}" --defaults-extra-file="${configPath}" ${database} > "${filepath}"`;

      console.log(`📦 Creating MariaDB backup for database: ${database}`);
      await execAsync(command);

      console.log(`✅ MariaDB backup created: ${filepath}`);
      return filepath;
    } catch (error) {
      this.logger.error('createMariaBackup: Error creating MariaDB backup', {
        tag: 'Cron',
        msg: `MariaDB backup failed: ${error.message}`,
        error: error.stack,
      });
      return null;
    }
  }

  async createSQLiteBackup(dbPath: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `sqlite_backup_${timestamp}.db`;
    const filepath = path.join(this.backupDir, filename);

    try {
      fs.copyFileSync(dbPath, filepath);
      console.log(`✅ SQLite backup created: ${filepath}`);
      return filepath;
    } catch (error) {
      this.logger.error('createSQLiteBackup: Error creating SQLite backup', {
        tag: 'Cron',
        msg: `SQLite backup failed: ${error.message}`,
        error: error.stack,
      });
      throw error;
    }
  }

  async cleanOldBackups(
    keepLastMariaDB: number = 10,
    keepLastSQLite: number = 10,
  ): Promise<void> {
    const files = fs.readdirSync(this.backupDir).reduce(
      (
        acc: { mariadb: BackupFile[]; sqlite: BackupFile[] },
        currentValue: string,
      ) => {
        const filepath = path.join(this.backupDir, currentValue);
        const stat = fs.statSync(filepath);
        if (currentValue.startsWith('mariadb_backup_')) {
          acc.mariadb.push({
            name: currentValue,
            time: stat.mtime.getTime(),
          });
        } else if (currentValue.startsWith('sqlite_backup_')) {
          acc.sqlite.push({
            name: currentValue,
            time: stat.mtime.getTime(),
          });
        }
        return acc;
      },
      { mariadb: [], sqlite: [] },
    );

    files.mariadb.sort((a, b) => b.time - a.time);
    files.sqlite.sort((a, b) => b.time - a.time);
    const toDelete = [
      ...files.mariadb.slice(keepLastMariaDB).map((f) => f.name),
      ...files.sqlite.slice(keepLastSQLite).map((f) => f.name),
    ];
    for (const file of toDelete) {
      try {
        fs.unlinkSync(path.join(this.backupDir, file));
        console.log(
          `🗑️ Deleted old backup: ${file} ${file.startsWith('mariadb_backup_') ? 'MariaDB' : 'SQLite'}`,
        );
      } catch (error) {
        this.logger.error('cleanOldBackups: Error deleting old backup', {
          tag: 'Cron',
          msg: `Error deleting old backup: ${file} ${file.startsWith('mariadb_backup_') ? 'MariaDB' : 'SQLite'}`,
          error: error.stack,
        });
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  private async scheduledDailyBackup() {
    console.log('🕒 [DAILY] Starting scheduled backup...');
    await this.createMariaBackup();
    await this.createSQLiteBackup('lite.db');
    await this.cleanOldBackups(120, 60);
  }

  @Cron(CronExpression.EVERY_WEEKEND)
  private async scheduledWeekendBackupCleanup() {
    await this.cleanOldBackups(90, 45);
  }
}
