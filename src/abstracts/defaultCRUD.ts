import { keyWithoutLike } from '@constants';
import { randomInt } from '@func';
import { merge } from 'ts-deepmerge';
import {
  DeepPartial,
  EntityManager,
  FindOptionsWhere,
  In,
  LessThan,
  LessThanOrEqual,
  Like,
  ObjectLiteral,
  Repository,
  MoreThan,
  MoreThanOrEqual,
} from 'typeorm';

/**
 * Abstract base class for CRUD operations
 *
 * Provides common database operations including:
 * - Entity creation, reading, updating, and deletion
 * - Advanced search with LIKE queries and array filtering
 * - Pagination support for large datasets
 * - Relation loading for nested data
 * - Transaction support through EntityManager
 * - Automatic query normalization and SQL injection protection
 *
 * @template T - Entity type that extends ObjectLiteral and has an id property
 * @template CreateDto - Data Transfer Object for creating entities
 * @template UpdateDto - Data Transfer Object for updating entities
 *
 * @see {@link UserService} for a complete implementation example
 */
export abstract class DefaultCRUDService<
  T extends ObjectLiteral & { id: number },
  CreateDto,
  UpdateDto,
  CreateBulkDto extends { entities?: any[] } = any,
  UpdateBulkDto extends { search: any[]; entities: any[] } = any,
> {
  constructor(private readonly repository: Repository<T>) {}

  private readonly comparisonOperators: Record<
    string,
    (value: number | Date | string) => any
  > = {
    '<': (v) => LessThan(v),
    '>': (v) => MoreThan(v),
    '>=': (v) => MoreThanOrEqual(v),
    '<=': (v) => LessThanOrEqual(v),
  } as const;

  private escapeLike(str: string): string {
    return str.replace(/[%_\\]/g, '\\$&');
  }
  getRepo(manager?: EntityManager): Repository<T> {
    return manager
      ? manager.getRepository(this.repository.metadata.target)
      : this.repository;
  }

  /**
   * Normalizes search object into TypeORM FindOptionsWhere format
   *
   * Supports multiple search patterns:
   * - String values: automatically converted to LIKE queries (unless in keyWithoutLike)
   * - Array values: converted to IN queries
   * - Comparison operators: suffix format { 'fieldName>': 10 }
   * - OR conditions: using 'or' key with array of conditions
   *
   * @param search - Search parameters object
   * @returns Normalized TypeORM FindOptionsWhere or undefined
   * @template T - Entity type
   *
   * @example
   * normalizeWhere({ name: "John" }) // { name: Like("%John%") }
   * normalizeWhere({ role: ["admin", "user"] }) // { role: In(["admin", "user"]) }
   * normalizeWhere({ or: [{ email: "john@example.com" }, { username: "john" }] }) // OR condition
   * normalizeWhere({ 'level>': 10 }) // { level: MoreThan(10) }
   * normalizeWhere({ 'price<=': 100 }) // { price: LessThanOrEqual(100) }
   */
  private async normalizeWhere(
    search?: Record<string, any>,
  ): Promise<FindOptionsWhere<T> | FindOptionsWhere<T>[] | undefined> {
    if (!search) return undefined;
    const base: Record<string, any> = {};
    const ors: FindOptionsWhere<T>[] = [];

    for (const [k, v] of Object.entries(search)) {
      if (v === undefined || v === null || v === '') continue;

      if (k === 'or' && Array.isArray(v)) {
        const normalizedOrs = await Promise.all(
          v.map((item) => this.normalizeWhere(item)),
        );
        ors.push(...(normalizedOrs.filter(Boolean) as FindOptionsWhere<T>[]));
        continue;
      }
      if (this.isTypeormOperator(v)) {
        base[k] = v;
        continue;
      }

      if (Array.isArray(v) && typeof v[0] !== 'object') {
        base[k] = In(v);
        continue;
      }

      if (typeof v === 'string') {
        base[k] = keyWithoutLike.includes(k)
          ? v
          : Like(`%${this.escapeLike(v)}%`);
        continue;
      }
      const operatorMatch = k.match(/^(.+?)([<>]=?)$/);
      if (operatorMatch) {
        const [, fieldName, operator] = operatorMatch;
        if (
          this.comparisonOperators[operator] &&
          (typeof v === 'number' || typeof v === 'string' || v instanceof Date)
        ) {
          base[fieldName] = this.comparisonOperators[operator](v);
          continue;
        }
      }
      base[k] = v;
    }

    return ors.length ? ors.map((o) => ({ ...base, ...o })) : base;
  }
  private isTypeormOperator(value: any): boolean {
    return value && typeof value === 'object' && '_type' in value;
  }

  /**
   * Creates a new entity in the database
   *
   * @param data - Entity creation data
   * @param manager - Optional EntityManager for transactions
   * @returns Promise<T> - Created entity
   * @template T - Entity type
   *
   * @example
   * const user = await userService.create({ name: "John", email: "john@example.com" });
   */
  async create(data: CreateDto, manager?: EntityManager): Promise<T> {
    const repo = this.getRepo(manager);

    const entity = repo.create(data as DeepPartial<T>);
    const savedEntity = await repo.save(entity);
    return savedEntity;
  }

  /**
   * Creates multiple entities in a single database operation
   *
   * @description
   * This method creates multiple entities in a single database operation.
   * It is optimized for performance and reduces the number of database queries.
   * In BulkDto you must pass the entities array.
   *
   * @param data - Bulk creation data containing entities array
   * @param manager - Optional EntityManager for transactions
   * @returns Promise<T[]> - Array of created entities
   * @template T - Entity type
   *
   * @example
   * const users = await userService.createBulk({
   *   entities: [{ name: "John" }, { name: "Jane" }]
   * });
   */
  async createBulk(data: CreateBulkDto, manager?: EntityManager): Promise<T[]> {
    const repo = this.getRepo(manager);
    const entities = repo.create(data.entities as DeepPartial<T>[]);
    const savedEntities = await repo.save(entities);
    return savedEntities;
  }
  /**
   * Counts entities matching the search criteria
   *
   * @param where - Search criteria object
   * @returns Promise<number> - Count of matching entities
   * @template T - Entity type
   *
   * @example
   * const count = await userService.count({ role: "admin" });
   * const totalUsers = await userService.count();
   */
  async count(
    where: { [key: string]: any } = {},
    manager?: EntityManager,
  ): Promise<number> {
    const normalizedWhere = (await this.normalizeWhere(
      where,
    )) as FindOptionsWhere<T>;
    return this.getRepo(manager).count({ where: normalizedWhere });
  }

  /**
   * Finds all entities with optional relations and pagination
   *
   * @param relations - Array of relation names to include
   * @param pageOpt - Pagination options (limit, page)
   * @returns Promise<T[]> - Array of entities
   * @template T - Entity type
   *
   * @example
   * const users = await userService.findAll(['profile', 'roles']);
   * const paginatedUsers = await userService.findAll([], { limit: 10, page: 1 });
   */
  async findAll(
    relations?: string[],
    pageOpt?: { limit: number; page: number },
    manager?: EntityManager,
    mode?: 'pessimistic_read' | 'pessimistic_write',
  ): Promise<T[]> {
    const options: any = {
      relations,
    };
    if (pageOpt) {
      options.skip = (pageOpt.page - 1) * pageOpt.limit;
      options.take = pageOpt.limit;
    }
    if (mode) {
      options.lock = { mode };
    }
    return this.getRepo(manager).find(options);
  }
  /**
   * Finds entities by search criteria with optional relations and pagination
   *
   * @param search - Search parameters object
   * @param relations - Array of relation names to include
   * @param pageOpt - Pagination options (limit, page)
   * @returns Promise<T[]> - Array of matching entities
   * @template T - Entity type
   *
   * @example
   * const users = await userService.findAllBySearch({ name: "John" });
   * const admins = await userService.findAllBySearch({ role: ["admin", "moderator"] });
   */
  async findAllBySearch(
    search?: { [key: string]: any },
    relations: string[] = [],
    pageOpt: { limit: number; page: number } = { limit: -1, page: -1 },
    sort?: { field: string; order: 'ASC' | 'DESC' }[],
    manager?: EntityManager,
    mode?: 'pessimistic_read' | 'pessimistic_write',
  ): Promise<T[]> {
    const options: any = {
      relations,
    };
    if (sort) {
      options.order = sort.reduce(
        (acc, s) => ({ ...acc, [s.field]: s.order }),
        {},
      );
    }
    const where: any = {};

    if (search) {
      const searchWhere = await this.normalizeWhere(search);
      if (searchWhere && Object.keys(searchWhere).length > 0) {
        Object.assign(where, searchWhere);
      }
    }
    if (pageOpt && pageOpt.page > 0 && pageOpt.limit > 0) {
      options.skip = (pageOpt.page - 1) * pageOpt.limit;
      options.take = pageOpt.limit;
    }
    if (mode) {
      options.lock = { mode };
    }
    const result = await this.getRepo(manager).find({ ...options, where });
    return result;
  }

  /**
   * Finds a single entity by search criteria
   *
   * @param where - Search criteria object
   * @param relations - Array of relation names to include
   * @returns Promise<T | null> - Found entity or null
   * @template T - Entity type
   *
   * @example
   * const user = await userService.findOne({ email: "john@example.com" });
   * const userWithProfile = await userService.findOne({ id: 1 }, ['profile']);
   */
  async findOne(
    where: { [key: string]: any },
    relations?: string[],
    sort?: { field: string; order: 'ASC' | 'DESC' }[],
    manager?: EntityManager,
    mode?: 'pessimistic_read' | 'pessimistic_write',
  ): Promise<T | null> {
    const normalizedWhere = (await this.normalizeWhere(
      where,
    )) as FindOptionsWhere<T>;
    const order = sort
      ? sort.reduce((acc, s) => ({ ...acc, [s.field]: s.order }), {})
      : undefined;
    const options: any = {
      where: normalizedWhere,
      relations,
      order,
    };
    if (mode) {
      options.lock = { mode };
    }
    return this.getRepo(manager).findOne(options);
  }

  async findDueForCompletion(
    searchData: {
      key: keyof T;
      value: any;
      type: 'common' | 'date';
      operator?: '<' | '<=' | '>' | '>=';
    }[],
    manager?: EntityManager,
    mode?: 'pessimistic_read' | 'pessimistic_write',
  ): Promise<T[]> {
    let where: FindOptionsWhere<T> = {};

    const commonWhere = searchData
      .filter((s) => s.type === 'common')
      .reduce((acc, s) => ({ ...acc, [String(s.key)]: s.value }), {});
    where = { ...where, ...(await this.normalizeWhere(commonWhere)) };

    const dateWhere = searchData
      .filter((s) => s.type === 'date')
      .reduce(
        (acc, s) => {
          const operator = s.operator || '<=';
          let dateValue = s.value;
          if (typeof dateValue === 'string') {
            dateValue = new Date(dateValue);
          }
          if (typeof dateValue === 'number') {
            dateValue = new Date(dateValue);
          }
          acc[`${String(s.key)}${operator}`] = dateValue;
          return acc;
        },
        {} as Record<string, any>,
      );
    where = { ...where, ...(await this.normalizeWhere(dateWhere)) };
    const options: any = {
      where,
    };
    if (mode) {
      options.lock = { mode };
    }
    return await this.getRepo(manager).find(options);
  }

  /**
   * Returns a random slice of entities matching the search criteria.
   *
   * Uses a random page offset: picks one random page and returns up to `limit`
   * consecutive rows from that page. This is pseudo-random — for `limit === 1`
   * you get one random row; for `limit > 1` you get one random block of
   * consecutive rows, not independently random items.
   *
   * @param where - Search criteria (same format as {@link findAllBySearch})
   * @param relations - Relation names to load
   * @param limit - Number of records per page (default 1)
   * @param manager - Optional EntityManager for transactions
   * @returns Promise<T[]> - Up to `limit` entities from a randomly chosen page
   *
   * @example
   * const one = await service.getRandom({ status: 'active' });
   * const block = await service.getRandom({ status: 'active' }, [], 5);
   */
  async getRandom(
    where: { [key: string]: any },
    relations: string[] = [],
    limit: number = 1,
    manager?: EntityManager,
  ): Promise<T[]> {
    const count = await this.count(where, manager);
    const maxPage = Math.max(1, Math.ceil(count / limit));
    const randomSkip = randomInt(1, maxPage);
    const records = await this.findAllBySearch(
      where,
      relations,
      { limit, page: randomSkip },
      undefined,
      manager,
    );
    return records;
  }

  /**
   * Updates an entity by ID or search criteria
   *
   * @param searchData - Entity ID (number) or search criteria object
   * @param updateData - Data to update
   * @param manager - Optional EntityManager for transactions
   * @returns Promise<T | null> - Updated entity or null if not found
   * @template T - Entity type
   *
   * @example
   * const updatedUser = await userService.update(1, { name: "John Updated" });
   * const updatedByEmail = await userService.update({ email: "john@example.com" }, { name: "John" });
   */
  async update(
    searchData: number | { [key: string]: any },
    updateData: UpdateDto,
    manager?: EntityManager,
  ): Promise<T | null> {
    let where: FindOptionsWhere<T>;
    if (typeof searchData === 'number') {
      where = { id: searchData } as FindOptionsWhere<T>;
    } else {
      where = (await this.normalizeWhere(searchData)) as FindOptionsWhere<T>;
    }
    const entity = await this.getRepo(manager).findOne({ where });
    if (!entity) {
      return null;
    }
    Object.assign(entity, updateData);
    const savedEntity = await this.getRepo(manager).save(entity);
    return savedEntity;
  }

  /**
   * Updates all entities matching the search criteria via find + save cycle.
   *
   * This mirrors {@link update} semantics and triggers entity lifecycle hooks
   * (e.g. @BeforeUpdate, subscribers) that are skipped by raw repo.update().
   *
   * @param searchData - Entity ID or search criteria object
   * @param updateData - Partial data to apply to all matched entities
   * @param manager - Optional EntityManager for transactions
   * @returns Promise<number> - Number of updated entities
   */
  async updateMany(
    searchData: number | { [key: string]: any },
    updateData: UpdateDto,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = this.getRepo(manager);
    const normalizedWhere =
      typeof searchData === 'number'
        ? ({ id: searchData } as FindOptionsWhere<T>)
        : ((await this.normalizeWhere(searchData)) as
            | FindOptionsWhere<T>
            | FindOptionsWhere<T>[]);
    const entities = await repo.find({
      where: normalizedWhere as any,
    });
    if (entities.length === 0) {
      return 0;
    }
    for (const entity of entities) {
      Object.assign(entity, updateData);
    }
    const saved = await repo.save(entities);
    return saved.length;
  }

  /**
   * Updates multiple entities in bulk with optimized database queries
   * @description
   * This method updates multiple entities in a single database operation.
   * It is optimized for performance and reduces the number of database queries.
   * In BulkDto you must pass the search array and the entities array.
   *
   * @param search - Array of search criteria for each entity
   * @param searchKeys - Array of keys to use for database search optimization
   * @param updateEntitiesData - Array of update data for each entity
   * @param manager - Optional EntityManager for transactions
   * @returns Promise<T[]> - Array of updated/created entities
   * @template T - Entity type
   *
   * @example
   * const updated = await userService.updateBulk(
   *   [{ chatId: 1, profileId: 1 }, { chatId: 2, profileId: 2 }],
   *   ['chatId'],
   *   [{ role: 'admin' }, { role: 'moderator' }]
   * );
   */
  async updateBulk(
    search: UpdateBulkDto['search'],
    searchKeys: (keyof UpdateBulkDto['search'][0])[],
    updateEntitiesData: UpdateBulkDto['entities'],
    manager?: EntityManager,
  ) {
    const allKeys = Object.keys(search[0]);
    const where: FindOptionsWhere<T> = {};
    for (const key of searchKeys) {
      where[key] = In(search.map((s) => s[key])) as any;
    }
    const entities = await this.getRepo(manager).find({ where });

    const updatedEntities: T[] = [];
    for (let i = 0; i < search.length; i++) {
      const searchItem = search[i];
      const updateData = updateEntitiesData[i];

      const existingEntity = entities.find((e) =>
        allKeys.every((key) => e[key] === searchItem[key]),
      );

      if (existingEntity) {
        Object.assign(existingEntity, updateData);
        updatedEntities.push(existingEntity);
      } else {
        const newEntity = this.getRepo(manager).create({
          ...updateData,
          ...searchItem,
        } as DeepPartial<T>);
        updatedEntities.push(newEntity);
      }
    }

    const savedUpdated = await this.getRepo(manager).save(updatedEntities);

    return savedUpdated;
  }

  /**
   * Increments a field value for an entity by normalized search criteria
   *
   * @param where - Search criteria object or entity ID
   * @param field - Field to increment
   * @param value - Amount to increment
   * @param manager - Optional EntityManager for transactions (default: current repository)
   * @returns Promise<void>
   * @template T - Entity type
   *
   * @example
   * await cartoonService.increment(1, 'weight', 1);
   * await cartoonService.increment({ slug: 'adventure-time' }, 'weight', 1);
   * await cartoonService.increment({ slug: 'adventure-time' }, 'weight', 1, manager);
   */
  async increment(
    where: number | { [key: string]: any },
    field: keyof T,
    value: number,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = this.getRepo(manager);
    const normalizedWhere =
      typeof where === 'number'
        ? ({ id: where } as FindOptionsWhere<T>)
        : ((await this.normalizeWhere(where)) as FindOptionsWhere<T>);
    await repo.increment(normalizedWhere, field as string, value);
  }

  /**
   * Decrements a field value for an entity by normalized search criteria
   *
   * @param where - Search criteria object or entity ID
   * @param field - Field to decrement
   * @param value - Amount to decrement
   * @param manager - Optional EntityManager for transactions (default: current repository)
   * @returns Promise<void>
   * @template T - Entity type
   *
   * @example
   * await cartoonService.decrement(1, 'weight', 1);
   * await cartoonService.decrement({ slug: 'adventure-time' }, 'weight', 1);
   * await cartoonService.decrement({ slug: 'adventure-time' }, 'weight', 1, manager);
   */
  async decrement(
    where: number | { [key: string]: any },
    field: keyof T,
    value: number,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = this.getRepo(manager);
    const normalizedWhere =
      typeof where === 'number'
        ? ({ id: where } as FindOptionsWhere<T>)
        : ((await this.normalizeWhere(where)) as FindOptionsWhere<T>);
    await repo.decrement(normalizedWhere, field as string, value);
  }

  /**
   * Removes an entity by ID
   *
   * @param id - Entity ID to remove
   * @param manager - Optional EntityManager for transactions
   * @returns Promise<void>
   * @template T - Entity type
   *
   * @example
   * await userService.remove(1);
   */
  async remove(
    where: number | { [key: string]: any },
    manager?: EntityManager,
  ): Promise<void> {
    const normalizedWhere =
      typeof where === 'number'
        ? ({ id: where } as FindOptionsWhere<T>)
        : ((await this.normalizeWhere(where)) as FindOptionsWhere<T>);
    await this.getRepo(manager).delete(normalizedWhere);
  }

  /**
   * Filters object fields based on specified selects and relations
   *
   * @description
   * This method checks if there's an intersection between requested fields (selects)
   * and relation fields or object fields. If intersection is found, returns objects
   * with only specified fields, otherwise returns full objects.
   *
   * @param {string[]} relations - Array of relation names (e.g., ['profile', 'settings'])
   * @param {string[]} selects - Array of fields to select (e.g., ['id', 'name', 'email'])
   *
   * @returns {Partial[]} Array of objects with filtered fields or full objects
   *
   * @example
   * ```typescript
   * // Filter by object fields
   * const users = [
   *   { id: 1, name: 'John', email: 'john@example.com', password: 'hash' }
   * ];
   * const filtered = selectFields([], ['id', 'name'], [users]);
   * // Result: [{ id: 1, name: 'John' }]
   *
   * // Filter by relations
   * const participants = [
   *   { id: 1, chatId: 1, profile: { name: 'John' } }
   * ];
   * const filtered = selectFields(['profile'], ['id', 'profile'], [participants]);
   * // Result: [{ id: 1, profile: { name: 'John' } }]
   *
   * // No intersection - return full objects
   * const filtered = selectFields(['chat'], ['id', 'name'], [users]);
   * // Result: [{ id: 1, name: 'John', email: 'john@example.com', password: 'hash' }]
   * ```
   */
  selectFields(relations: string[], selects: string[], objs: any[]) {
    const hasRelationFields =
      relations &&
      selects &&
      selects.some((select) => relations.includes(select));

    const hasObjectFields =
      objs.length > 0 &&
      selects &&
      selects.some((select) => Object.keys(objs[0]).includes(select));

    if (hasRelationFields || hasObjectFields) {
      return objs.map((obj) => {
        const selectedFields = {};
        selects.forEach((select) => {
          if (obj[select] !== undefined) {
            selectedFields[select] = obj[select];
          }
        });
        return selectedFields;
      });
    }
    return objs;
  }

  splitFields<T extends Record<string, any>>(entity: T, fields: string[]) {
    const base: any = { ...entity };
    const fs: Record<string, any> = {};

    const topLevel = Array.from(
      new Set(
        fields.map((f) => {
          if (f.split('.').length > 1) {
            return f.split('.')[0];
          }
          return f;
        }),
      ),
    );

    for (const key of topLevel) {
      if (key in base) {
        fs[key] = base[key];
        delete base[key];
      }
    }
    return { base, fs };
  }

  /**
   * Merges multiple objects into one using lodash merge
   *
   * @param mainObj - Main object to merge into
   * @param args - Additional objects to merge
   * @returns Merged object
   *
   * @example
   * const result = this.convertObj({ a: 1 }, [{ b: 2 }, { c: 3 }]);
   * // Result: { a: 1, b: 2, c: 3 }
   */
  convertObj(mainObj, args: any[]) {
    return merge({}, mainObj, ...args);
  }

  /**
   * Sorts relations by nesting depth for proper relation loading
   *
   * @param {string[]} relations - Array of relation names
   *
   * @returns {string[]} Sorted array by ascending depth
   *
   * @example
   * ```typescript
   * const sorted = relationsSorts(['user.profile', 'chat', 'user.profile.settings']);
   * // Result: ['chat', 'user.profile', 'user.profile.settings']
   * ```
   */
  relationsSorts(relations: string[]) {
    return [...new Set(relations)].sort((a, b) => {
      const depthA = a.split('.').length;
      const depthB = b.split('.').length;
      return depthA - depthB;
    });
  }
}
