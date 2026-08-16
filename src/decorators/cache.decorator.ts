import { InvalidCache } from './invalid-cache.decorator';
import { CacheInterceptor } from './../interceptors/cache/cache.interceptor';
import { SetMetadata } from '@nestjs/common';
export const CACHE_KEY = 'cache_options';
export interface CacheOptions {
  ttl?: number;
  key: string;
  includeUser?: boolean;
}

/**
 * Cache decorator for HTTP response caching
 *
 * Enables caching of endpoint responses with configurable TTL and key patterns.
 * Supports dynamic route parameters in cache keys for per-resource caching.
 *
 * @param options - Cache configuration options
 * @param options.key - Cache key pattern (supports {paramName} or :paramName syntax)
 * @param options.ttl - Time to live in seconds (default: 60)
 * @param options.includeUser - Include user ID in cache key (default: false)
 *
 * @example
 * // Simple caching with static key
 * ```
 * ⁣@Get('list')
 * ⁣@Cache({ key: 'banks:list', ttl: 300 })
 * findAll() {
 *   return this.bankService.findAll();
 * }
 * ```
 * @example
 * // Caching with dynamic route parameter
 * ```
 * ⁣@Get(':id')
 * ⁣@Cache({ key: 'bank:{id}', ttl: 300 })
 * findOne(@Param('id') id: number) {
 *   return this.bankService.findOne({ id });
 * }
 * ```
 * @example
 * // Caching with multiple parameters
 * ```
 * ⁣@Get(':id/items/:itemId')
 * ⁣@Cache({ key: 'bank:{id}:items:{itemId}', ttl: 300 })
 * getItem( ⁣@Param('id') id: number,  ⁣@Param('itemId') itemId: number) {
 *   return this.bankService.getItem(id, itemId);
 * }
 * ```
 *  *
 * @example
 * // User-specific caching
 * ```
 * ⁣@Get('my-bank')
 * ⁣@Cache({ key: 'bank:user', includeUser: true, ttl: 300 })
 * getMyBank(⁣@Req() req: ReqWithUser) {
 *   return this.bankService.findOne({ userId: req.user.userId });
 * }
 * ```
 *
 * @see {@link CacheInterceptor} for cache implementation
 * @see {@link InvalidCache} for cache invalidation
 */
export const Cache = (options: CacheOptions) => SetMetadata(CACHE_KEY, options);
