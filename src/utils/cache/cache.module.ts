import { CacheInterceptor } from '@interceptors';
import { Module, Global } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * Cache module for caching responses
 *
 * Provides a service for caching responses with configurable TTL and key patterns.
 * Supports dynamic route parameters in cache keys for per-resource caching.
 *
 * @see {@link CacheService} for cache implementation
 * @see {@link CacheInterceptor} for cache interceptor
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
