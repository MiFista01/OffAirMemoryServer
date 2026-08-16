import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, tap } from 'rxjs';
import { CACHE_KEY, CacheOptions } from 'src/decorators/cache.decorator';
import { ReqWithUser } from 'src/configs/types';
import {
  INVALIDATE_CACHE_KEY,
  InvalidateCacheOptions,
} from 'src/decorators/invalid-cache.decorator';
import { CacheService } from '@utils';

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    private reflector: Reflector,
    private cacheService: CacheService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<ReqWithUser>();
    const user = request.user;

    const invalidateOptions = this.reflector.get<InvalidateCacheOptions>(
      INVALIDATE_CACHE_KEY,
      context.getHandler(),
    );

    if (invalidateOptions) {
      const resolvedPatterns = this.resolvePatterns(
        invalidateOptions.patterns,
        request,
      );
      const userId =
        invalidateOptions.selfInvalidate && user?.userId
          ? user.userId
          : undefined;
      this.cacheService.invalidate(resolvedPatterns, userId);
    }

    const options = this.reflector.get<CacheOptions>(
      CACHE_KEY,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    const key = this.generateCacheKey(options, user, request);

    const cacheData = this.cacheService.get(
      key,
      user ? user.userId : undefined,
    );
    if (cacheData) {
      return of(cacheData);
    }

    return next.handle().pipe(
      tap((data) => {
        const ttl = options.ttl || 60;
        this.cacheService.set(key, data, ttl, user ? user.userId : undefined);
      }),
    );
  }

  private generateCacheKey(
    options: CacheOptions,
    user: any,
    request: ReqWithUser,
  ): string {
    const key = this.resolvePlaceholders(options.key, request);

    const parts: string[] = [key];

    if (options.includeUser && user?.userId) {
      parts.push(`user:${user.userId}`);
    }

    if (request.query && Object.keys(request.query).length > 0) {
      const sortedQuery = Object.keys(request.query)
        .sort()
        .reduce((acc, key) => {
          acc[key] = request.query[key];
          return acc;
        }, {});
      parts.push(JSON.stringify(sortedQuery));
    }

    if (request.body && Object.keys(request.body).length > 0) {
      const sortedBody = Object.keys(request.body)
        .sort()
        .reduce((acc, key) => {
          acc[key] = request.body[key];
          return acc;
        }, {});
      parts.push(JSON.stringify(sortedBody));
    }

    return parts.join(':');
  }

  private resolvePlaceholders(key: string, request: ReqWithUser): string {
    const params = request.params || {};

    key = key.replace(/\{(\w+)\}/g, (match, paramName) => {
      return params[paramName] !== undefined
        ? String(params[paramName])
        : match;
    });

    key = key.replace(/:(\w+)/g, (match, paramName) => {
      if (params[paramName] !== undefined && !key.includes(`{${paramName}}`)) {
        return String(params[paramName]);
      }
      return match;
    });

    return key;
  }

  private resolvePatterns(patterns: string[], request: ReqWithUser): string[] {
    return patterns.map((pattern) =>
      this.resolvePlaceholders(pattern, request),
    );
  }

  private invalidate(patterns: string[]) {
    this.cacheService.invalidate(patterns);
  }
}
