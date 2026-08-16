import { CacheInterceptor } from './../interceptors/cache/cache.interceptor';
import { SetMetadata } from '@nestjs/common';
export const INVALIDATE_CACHE_KEY = 'invalidate_cache_options';
export interface InvalidateCacheOptions {
  patterns: string[];
  selfInvalidate?: boolean;
}

/**
 * Cache invalidation decorator for clearing cached responses
 *
 * @example
 * ```
 * @Patch(':id')
 * @InvalidCache(['cartoon:{id}', 'channels:list'])
 * update(@Param('id') id: number, @Body() dto: UpdateCartoonDto) {
 *   return this.cartoonService.update(id, dto);
 * }
 * ```
 * @example
 * ```
 * @InvalidCache(['profile:me'], true)
 * updateMyProfile(...) { ... }
 * ```
 *
 * @see {@link Cache}
 * @see {@link CacheInterceptor}
 */
export const InvalidCache = (patterns: string[], selfInvalidate?: boolean) =>
  SetMetadata(INVALIDATE_CACHE_KEY, { patterns, selfInvalidate });
