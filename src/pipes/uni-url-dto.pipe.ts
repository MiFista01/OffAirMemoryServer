import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * Universal Parameters Pipe for DTO validation and transformation
 *
 * Creates instances of DTO classes from raw parameter values and validates them
 * using class-validator and class-transformer decorators.
 *
 * @template T - The type of DTO class to instantiate and validate
 * @param dtoClass - Constructor function of the DTO class
 * @param value - Raw parameter value from the request
 * @returns Validated DTO instance
 * @throws {BadRequestException} When validation fails
 *
 */
@Injectable()
export class UniUrlDtoPipe<T, I> implements PipeTransform {
  constructor(
    private dtoClass: new (data?: any) => T,
    private urlType: 'query' | 'params',
    private includesDto?: new (data?: any) => I,
  ) {}
  async transform(rawValue: any) {
    const instance = plainToInstance(this.dtoClass, {
      value: rawValue,
    }) as T & { value: any };

    if (
      this.urlType === 'query' &&
      Array.isArray(instance.value) &&
      this.includesDto
    ) {
      const array: any[] = [];
      for (let i = 0; i < instance.value.length; i++) {
        const item = instance.value[i];
        if (item === null || item === undefined) continue;

        try {
          const includesInstance = plainToInstance(this.includesDto, {
            value: item,
          }) as I & { value: any };
          array.push(await this.validateValue(includesInstance));
        } catch (error) {
          if (error instanceof BadRequestException) {
            throw new BadRequestException(
              `Validation failed for item at index ${i}: ${error.message}`,
            );
          }
          throw error;
        }
      }
      if (array.length === 0 && instance.value.length > 0) {
        throw new BadRequestException('All array items are null or undefined');
      }
      return array;
    }

    return this.validateValue(instance);
  }

  private async validateValue(instance: any) {
    const errors = await validate(instance);
    if (errors.length > 0) {
      const errorMessages = errors
        .map((error) => {
          const constraintMessages = Object.values(
            error.constraints || {},
          ).join(', ');
          const nestedErrors =
            error.children
              ?.map((child) =>
                Object.values(child.constraints || {}).join(', '),
              )
              .join(', ') || '';
          return [constraintMessages, nestedErrors].filter(Boolean).join('; ');
        })
        .join('; ');

      throw new BadRequestException(`Validation failed: ${errorMessages}`);
    }
    return instance.value;
  }
}
