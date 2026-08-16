import { CacheInterceptor } from './../interceptors/cache/cache.interceptor';
import { SetMetadata } from '@nestjs/common';
export const INVALIDATE_CACHE_KEY = 'invalidate_cache_options';
export interface InvalidateCacheOptions {
  patterns: string[];
  selfInvalidate?: boolean; // If true, the cache will be invalidated for the current user
}

/**
 * Cache invalidation decorator for clearing cached responses
 *
 * Invalidates cache entries matching specified patterns before executing the method.
 * Supports dynamic route parameters, wildcard patterns, and per-user (self) invalidation.
 *
 * @param patterns - Array of cache key patterns to invalidate
 * @param selfInvalidate - If true, invalidates only cache entries of the current authenticated user (keys stored with includeUser). Use to avoid clearing cache for all users when one user mutates their data.
 *
 * @example
 * ```
 * // Invalidate specific cache entry
 * ⁣@Patch(':id')
 * ⁣@InvalidCache(['bank:{id}'])
 * update(⁣@Param('id') id: number, ⁣@Body() dto: UpdateBankDto) {
 *   return this.bankService.update(id, dto);
 * }
 * ```
 * @example
 * ```
 * // Invalidate only current user's cache (self)
 * ⁣@InvalidCache(['inventory:my', 'inventory:findOne:{id}'], true)
 * update(⁣@Param('id') id: number, ⁣@Body() dto: UpdateInventoryDto) { ... }
 * ```
 * @example
 * ```
 * // Invalidate with wildcard pattern
 * ⁣@Patch(':id')
 * ⁣@InvalidCache(['bank:{id}:*'])
 * update(⁣@Param('id') id: number, ⁣@Body() dto: UpdateBankDto) {
 *   return this.bankService.update(id, dto);
 * }
 * ```
 * @example
 * ```
 * // Invalidate multiple patterns
 * ⁣@Post('sell-items')
 * ⁣@InvalidCache(['bank:*', 'user:{userId}:bank'])
 * sellItems(
 *   ⁣@Req() req: ReqWithUser,
 *   ⁣@Body() dto: SellItemsDto
 * ) {
 *   return this.bankService.sellItems(dto.items, req.user.userId);
 * }
 * ```
 * @example
 * ```
 * // Invalidate with dynamic parameters
 * ⁣@Delete(':id')
 * ⁣@InvalidCache(['bank:{id}', 'bank:{id}:items:*', 'bank:{id}:stats'])
 * remove(@Param('id') id: number) {
 *   return this.bankService.remove(id);
 * }
 * // Invalidates multiple related cache entries
 * ```
 * @example
 * ```
 * // Global invalidation pattern (use with caution!)
 * ⁣@Post('reset-all')
 * ⁣⁣@InvalidCache(['*'])
 * resetAll() {
 *   return this.bankService.resetAll();
 * }
 * // Invalidates ALL cache entries
 * ```
 * @remarks
 * - Patterns support dynamic route parameters: {id}, {userId}, :id, :userId
 * - Wildcard (*) matches any characters
 * - Multiple patterns can be specified for comprehensive cache clearing
 * - When selfInvalidate is true, only keys associated with request.user.userId are considered; other users' cache is left intact
 * - Invalidation happens BEFORE method execution
 *
 * @see {@link Cache} for cache configuration
 * @see {@link CacheInterceptor} for cache implementation
 */
export const InvalidCache = (patterns: string[], selfInvalidate?: boolean) =>
  SetMetadata(INVALIDATE_CACHE_KEY, { patterns, selfInvalidate });
