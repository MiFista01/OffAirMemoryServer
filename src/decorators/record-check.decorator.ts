import { SetMetadata } from '@nestjs/common';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ObjectLiteral } from 'typeorm';

export interface RecordCheckOptions<T extends ObjectLiteral & { id: number }> {
  service: new (...args: any[]) => DefaultCRUDService<T, any, any>;
  invalidateCacheKey?: string[];
  invalidateCacheKeyResolver?: (
    records: T[],
    params: Record<string, any>,
  ) => string[];
  filteredRecords?: (
    service: DefaultCRUDService<T, any, any>,
  ) => Promise<T[]> | T[];
  processRecord: (
    record: T,
    service: DefaultCRUDService<T, any, any>,
  ) => Promise<T | null> | T | null;
  usedParams?: string[];
  getRecords?: (
    params: Record<string, any>,
    service: DefaultCRUDService<T, any, any>,
  ) => Promise<T[] | null> | T[] | null;
}

export const CHECK_RECORD_KEY = 'check_record';
export const CheckRecord = <T extends ObjectLiteral & { id: number }>(
  config: RecordCheckOptions<T> | RecordCheckOptions<any>[],
) => SetMetadata(CHECK_RECORD_KEY, Array.isArray(config) ? config : [config]);
