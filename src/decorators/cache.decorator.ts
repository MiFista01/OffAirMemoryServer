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
 * @example
 * ```
 * @Get()
 * @Cache({ key: 'channels:list', ttl: 300 })
 * findAll() {
 *   return this.channelsService.findAll();
 * }
 * ```
 * @example
 * ```
 * @Get(':id')
 * @Cache({ key: 'cartoon:{id}', ttl: 300 })
 * findOne(@Param('id') id: number) {
 *   return this.cartoonService.findOne({ id });
 * }
 * ```
 * @example
 * ```
 * @Get('me')
 * @Cache({ key: 'profile:me', includeUser: true, ttl: 300 })
 * getMyProfile(@Req() req: ReqWithUser) {
 *   return this.profileService.findOne({ userId: req.user.userId });
 * }
 * ```
 *
 * @see {@link CacheInterceptor}
 * @see {@link InvalidCache}
 */
export const Cache = (options: CacheOptions) => SetMetadata(CACHE_KEY, options);
