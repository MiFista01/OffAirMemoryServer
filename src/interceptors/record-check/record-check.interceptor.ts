import { CHECK_RECORD_KEY, RecordCheckOptions } from '@decorators';
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { CacheService } from '@utils';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Observable } from 'rxjs';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';
import { ObjectLiteral } from 'typeorm';
import { Logger } from 'winston';

@Injectable()
export class RecordCheckInterceptor
  extends DefaultLogMsg
  implements NestInterceptor
{
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER)
    protected readonly logger: Logger,
    private reflector: Reflector,
    private moduleRef: ModuleRef,
    private cacheService: CacheService,
  ) {
    super(logger);
  }
  protected readonly tag = 'Error';

  async intercept<T extends ObjectLiteral & { id: number }>(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    try {
      const handlerConfigs =
        this.reflector.get<RecordCheckOptions<any>[]>(
          CHECK_RECORD_KEY,
          context.getHandler(),
        ) || [];

      const classConfigs =
        this.reflector.get<RecordCheckOptions<any>[]>(
          CHECK_RECORD_KEY,
          context.getClass(),
        ) || [];

      const configs = [...classConfigs, ...handlerConfigs];
      if (configs.length === 0) {
        return next.handle();
      }

      const request = context.switchToHttp().getRequest();
      const cacheKeys: string[] = [];

      await Promise.all(
        configs.map(async (config) => {
          try {
            const result = await this.processConfig(config, request);
            if (result.updatedRecords.length > 0) {
              if (config.invalidateCacheKey) {
                cacheKeys.push(...config.invalidateCacheKey);
              }
              if (config.invalidateCacheKeyResolver) {
                const dynamicKeys = config.invalidateCacheKeyResolver(
                  result.updatedRecords,
                  result.params,
                );
                cacheKeys.push(...dynamicKeys);
              }
            }
          } catch (error) {
            this.logMessage(
              'error',
              `Error processing config for ${config.service.name}`,
              {
                error: error.message,
                stack: error.stack,
                msg: `Config processing failed for ${config.service.name}: ${error.message}`,
                serviceName: config.service.name,
              },
            );
          }
        }),
      );

      if (cacheKeys.length > 0) {
        const uniqueKeys = [...new Set(cacheKeys)];
        this.cacheService.invalidate(uniqueKeys);
      }
    } catch (error) {
      this.logMessage('error', 'Record check interceptor error', {
        error: error.message,
        stack: error.stack,
        msg: `Record check interceptor failed: ${error.message}`,
      });
      throw error;
    }

    return next.handle();
  }

  private async processConfig(
    config: RecordCheckOptions<any>,
    request: any,
  ): Promise<{ updatedRecords: any[]; params: Record<string, any> }> {
    const service = this.moduleRef.get(config.service, { strict: false });
    if (!service) {
      return { updatedRecords: [], params: {} };
    }

    const params = this.extractParams(config, request);
    const records = await this.getRecordsForConfig(config, params, service);
    const updatedRecords = await this.processRecords(records, config, service);

    if (updatedRecords.length > 0) {
      await service.getRepo().save(updatedRecords);
    }

    return { updatedRecords, params };
  }

  private extractParams(
    config: RecordCheckOptions<any>,
    request: any,
  ): Record<string, any> {
    const params: Record<string, any> = {};
    for (const paramName of config.usedParams || []) {
      const value = request.params[paramName];
      if (value !== undefined) {
        params[paramName] = value;
      }
    }
    return params;
  }

  private async getRecordsForConfig(
    config: RecordCheckOptions<any>,
    params: Record<string, any>,
    service: any,
  ): Promise<any[]> {
    const records = await this.resolveValue(
      config.usedParams && config.getRecords
        ? config.getRecords(params, service) || []
        : config.filteredRecords?.(service) || [],
    );
    return Array.isArray(records) ? records : [];
  }

  private async processRecords(
    records: any[],
    config: RecordCheckOptions<any>,
    service: any,
  ): Promise<any[]> {
    const processed = await Promise.all(
      records.map(async (record) => {
        try {
          return await this.resolveValue(config.processRecord(record, service));
        } catch (error) {
          this.logMessage(
            'warn',
            `Error processing record ${record.id}`,
            {
              error: error.message,
              stack: error.stack,
              msg: `Failed to process record ${record.id}: ${error.message}`,
              recordId: record.id,
              serviceName: config.service.name,
            },
            'Warn',
          );
          return null;
        }
      }),
    );
    return processed.filter(
      (record): record is any => record !== null && record !== undefined,
    );
  }

  private async resolveValue<T>(value: Promise<T> | T): Promise<T> {
    return value instanceof Promise ? await value : value;
  }
}
