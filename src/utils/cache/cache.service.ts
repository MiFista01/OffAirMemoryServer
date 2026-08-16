import { Cron, CronExpression } from '@nestjs/schedule';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';

@Injectable()
export class CacheService {
  private cache = new Map<string, { data: any; expires: number }>();
  private usersKeys = new Map<number, string[]>();
  private readonly MAX_SIZE = 10000;
  private readonly MAX_MEMORY_MB = 500;
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER)
    protected readonly logger: Logger,
  ) {}

  get(key: string, userId?: number): any | undefined {
    const cacheData = this.cache.get(key);
    if (cacheData && cacheData.expires <= Date.now()) {
      this.cache.delete(key);
      const userKeys = this.usersKeys.get(userId || -1);
      if (userKeys && userId) {
        const filteredKeys = userKeys.filter((k) => k !== key);
        this.usersKeys.set(userId, filteredKeys);
      }
      return undefined;
    }
    if (cacheData && cacheData.expires > Date.now()) {
      return cacheData.data;
    }
    return undefined;
  }

  set(key: string, data: any, ttl: number, userId?: number): void {
    if (this.cache.size >= this.MAX_SIZE) {
      this.privateEvictOldest();
    }

    try {
      const dataSize = JSON.stringify(data).length;
      const currentMemoryMB = this.estimateMemoryMB();

      if (currentMemoryMB + dataSize / 1024 / 1024 > this.MAX_MEMORY_MB) {
        this.privateEvictOldest();
      }
      if (userId) {
        const userKeys = this.usersKeys.get(userId) || [];
        userKeys.push(key);
        this.usersKeys.set(userId, [...new Set(userKeys)]);
      }

      this.cache.set(key, {
        data,
        expires: Date.now() + ttl * 1000,
      });
    } catch (error) {
      console.warn(
        'Failed to cache response due to serialization error:',
        error,
      );
    }
  }

  invalidate(patterns: string[], userId?: number): void {
    if (userId !== undefined && userId !== null) {
      const userKeys = this.usersKeys.get(userId);
      if (userKeys?.length) {
        const remaining: string[] = [];
        for (const key of userKeys) {
          const matches = patterns.some((pattern) =>
            this.matchPattern(key, pattern),
          );
          if (matches) {
            this.cache.delete(key);
          } else {
            remaining.push(key);
          }
        }
        if (remaining.length === 0) {
          this.usersKeys.delete(userId);
        } else {
          this.usersKeys.set(userId, remaining);
        }
        return;
      }
    } else {
      for (const pattern of patterns) {
        for (const key of Array.from(this.cache.keys())) {
          if (this.matchPattern(key, pattern)) {
            this.cache.delete(key);
            this.privateRemoveKeyFromUsersKeys(key);
          }
        }
      }
    }
  }

  private privateRemoveKeyFromUsersKeys(key: string): void {
    for (const [uid, keys] of this.usersKeys.entries()) {
      const filtered = keys.filter((k) => k !== key);
      if (filtered.length !== keys.length) {
        if (filtered.length === 0) {
          this.usersKeys.delete(uid);
        } else {
          this.usersKeys.set(uid, filtered);
        }
        return;
      }
    }
  }

  private matchPattern(key: string, pattern: string): boolean {
    if (pattern.includes('*')) {
      const escapedPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      const regex = new RegExp(`^${escapedPattern}$`);
      return regex.test(key);
    }

    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `^${escapedPattern}$|:${escapedPattern}:|:${escapedPattern}$|^${escapedPattern}:`,
    );
    return regex.test(key);
  }

  private privateEvictOldest() {
    const entries = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].expires - b[1].expires,
    );
    if (entries.length === 0) return;

    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      const key = entries[i][0];
      this.cache.delete(key);
      this.privateRemoveKeyFromUsersKeys(key);
    }
  }

  private estimateMemoryMB(): number {
    let total = 0;
    for (const [key, value] of this.cache.entries()) {
      try {
        total += key.length + JSON.stringify(value.data).length;
      } catch (error) {
        total += key.length;
      }
    }
    return total / 1024 / 1024;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  private cleanup() {
    const now = Date.now();
    try {
      for (const [key, value] of this.cache.entries()) {
        if (value.expires <= now) {
          this.cache.delete(key);
          this.privateRemoveKeyFromUsersKeys(key);
        }
      }
    } catch (error) {
      this.logger.warn('cleanup: Failed to cleanup cache due to error:', {
        tag: 'Cron',
        msg: `Failed to cleanup cache due to error: ${error.message}`,
        error: error.stack,
      });
    }
  }
}
