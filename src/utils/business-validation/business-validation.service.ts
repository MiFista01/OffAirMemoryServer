import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

/**
 * Validation utility service for common business logic checks
 *
 * Provides reusable validation methods to avoid code duplication
 * across services and controllers.
 *
 * @example
 * // In service:
 * this.businessValidationService.assertExists(channel, 'Channel not found');
 * this.businessValidationService.assertOwnership(profile, userId, 'You are not the owner');
 */
@Injectable()
export class BusinessValidationService {
  /**
   * Asserts that entity exists, throws NotFoundException if not
   */
  assertExists<T>(
    entity: T | null | undefined,
    message: string = 'Resource not found',
  ): asserts entity is T {
    if (!entity) {
      throw new NotFoundException(message);
    }
  }

  assertIsFullString(
    value: string | null | undefined,
    message: string = 'Value is not a full string',
  ): asserts value is string {
    if (!value || value.trim() === '' || typeof value !== 'string') {
      throw new BadRequestException(message);
    }
  }

  /**
   * Asserts that two values are equal
   */
  assertEqual<T>(
    value1: T,
    value2: T,
    message: string = 'Values are not equal',
  ): asserts value1 is T {
    const isObj1 = typeof value1 === 'object' && value1 !== null;
    const isObj2 = typeof value2 === 'object' && value2 !== null;
    switch (true) {
      case Array.isArray(value1) && Array.isArray(value2):
        if (value1.length !== value2.length) {
          throw new BadRequestException(message);
        }
        for (let i = 0; i < value1.length; i++) {
          if (typeof value1[i] === 'object' || Array.isArray(value1[i])) {
            this.assertEqual(value1[i], value2[i], message);
            continue;
          }
          if (value1[i] !== value2[i]) {
            throw new BadRequestException(message);
          }
        }
        break;
      case isObj1 && isObj2:
        const obj1 = Object.entries(value1 as Record<string, any>);
        const obj2 = Object.entries(value2 as Record<string, any>);
        if (obj1.length !== obj2.length) {
          throw new BadRequestException(message);
        }
        for (const [k, v] of obj1) {
          const pair2 = obj2.find(([key]) => key === k);
          if (!pair2) {
            throw new BadRequestException(message);
          }
          if ((typeof v === 'object' && v !== null) || Array.isArray(v)) {
            this.assertEqual(v, pair2[1], message);
            continue;
          }
          if (pair2[1] !== v) {
            throw new BadRequestException(message);
          }
        }
        break;
      default:
        if (value1 !== value2) {
          throw new BadRequestException(message);
        }
        break;
    }
  }

  /**
   * Asserts that entity has specific key with specific value
   * Supports multiple comparison operators and custom predicates
   *
   * @example
   * // Simple equality (default)
   * this.assertObjKey(episode, { key: 'cartoonId', value: cartoonId });
   *
   * @example
   * // With operator
   * this.assertObjKey(item, { key: 'quantity', value: 2, operator: '>=' });
   *
   * @example
   * // With custom predicate
   * this.assertObjKey(channel, {
   *   key: 'isActive',
   *   predicate: (val) => val === true
   * });
   *
   * @example
   * // In array
   * this.assertObjKey(episode, { key: 'kind', value: ['episode', 'special'], operator: 'in' });
   */
  assertObjKey<T>(
    entity: T | T[],
    options: {
      key: keyof T;
      value?: any;
      operator?: '===' | '!==' | '>' | '<' | '>=' | '<=' | 'in' | 'notIn';
      predicate?: (value: any) => boolean;
    },
    message: string = 'Invalid data',
  ): asserts entity is T | T[] {
    if (Array.isArray(entity)) {
      entity.forEach((item) => this.assertObjKey(item, options, message));
      return;
    }

    const entityValue = entity[options.key];

    if (options.predicate) {
      if (!options.predicate(entityValue)) {
        throw new BadRequestException(message);
      }
      return;
    }

    if (options.operator && options.value === undefined) {
      throw new Error('Value is required when using operator');
    }

    const expectedValue = options.value;
    const operator = options.operator || '===';

    let isValid = false;

    switch (operator) {
      case '===':
        isValid = entityValue === expectedValue;
        break;
      case '!==':
        isValid = entityValue !== expectedValue;
        break;
      case '>':
      case '<':
      case '>=':
      case '<=':
        if (
          typeof entityValue !== 'number' ||
          typeof expectedValue !== 'number'
        ) {
          throw new Error(
            `Comparison operators (${operator}) can only be used with numbers`,
          );
        }
        isValid = this.compareNumbers(entityValue, expectedValue, operator);
        break;
      case 'in':
        if (!Array.isArray(expectedValue)) {
          throw new Error('Operator "in" requires array as value');
        }
        isValid = expectedValue.includes(entityValue);
        break;
      case 'notIn':
        if (!Array.isArray(expectedValue)) {
          throw new Error('Operator "notIn" requires array as value');
        }
        isValid = !expectedValue.includes(entityValue);
        break;
    }

    if (!isValid) {
      throw new BadRequestException(message);
    }
  }

  /**
   * Helper method for number comparison
   */
  private compareNumbers(
    a: number,
    b: number,
    operator: '>' | '<' | '>=' | '<=',
  ): boolean {
    switch (operator) {
      case '>':
        return a > b;
      case '<':
        return a < b;
      case '>=':
        return a >= b;
      case '<=':
        return a <= b;
    }
  }

  /**
   * Asserts that array has no duplicates
   */
  assertNoDuplicates<T>(
    array: T[],
    message: string = 'Duplicate items found',
  ): asserts array is T[] {
    const unique = new Set([...array]);
    if (unique.size !== array.length) {
      throw new BadRequestException(message);
    }
  }

  /**
   * Asserts that array is not empty
   */
  assertNotEmpty<T>(
    array: T[] | null | undefined,
    message: string = 'Array cannot be empty',
  ): asserts array is T[] {
    if (!array || array.length === 0) {
      throw new BadRequestException(message);
    }
  }

  /**
   * Asserts that value is greater than or equal to minimum
   */
  assertMin(
    value: number,
    min: number,
    message?: string,
  ): asserts value is number {
    if (typeof value !== 'number' || Number.isNaN(value) || value < min) {
      throw new BadRequestException(
        message || `Value must be at least ${min}, but got ${value}`,
      );
    }
  }

  /**
   * Asserts that value is less than or equal to maximum
   */
  assertMax(
    value: number,
    max: number,
    message?: string,
  ): asserts value is number {
    if (typeof value !== 'number' || Number.isNaN(value) || value > max) {
      throw new BadRequestException(
        message || `Value must be at most ${max}, but got ${value}`,
      );
    }
  }

  /**
   * Asserts that array contains no items from another array
   *
   * Checks if there are any common items between two arrays. Throws BadRequestException
   * if intersection is found. Useful for validating that new items don't already exist.
   *
   * @template T - Type of array items
   * @param array1 - First array to check for intersection
   * @param array2 - Second array to check for intersection
   * @param message - Custom error message (default: 'Items already exist')
   * @param key - Optional key to compare objects by specific property
   *
   * @throws {BadRequestException} When arrays have at least one common item
   *
   * @example
   * // Simple comparison
   * this.assertNoIntersection([1, 2], [2, 3], 'Items already exist');
   * // Throws: BadRequestException - 2 is in both arrays
   *
   * @example
   * // Object comparison by key
   * this.assertNoIntersection(newItems, existingItems, 'Items exist', 'id');
   */
  assertNoIntersection<T>(
    array1: T[],
    array2: T[],
    message: string = 'Items already exist',
    key?: keyof T,
  ): asserts array1 is T[] {
    const hasIntersection = array1.some((item) => {
      if (key) {
        const itemValue = item[key];
        return array2.some((item2) => item2[key] === itemValue);
      }
      return array2.includes(item);
    });
    if (hasIntersection) {
      throw new BadRequestException(message);
    }
  }

  /**
   * Asserts that array contains all required items
   *
   * Validates that target array contains every item from required items array.
   * Useful for checking that user has all necessary items before operation.
   *
   * @template T - Type of array items
   * @param array - Target array to check (e.g., user's items)
   * @param requiredItems - Array of items that must all be present
   * @param message - Custom error message (default: 'Not all required items are present')
   * @param key - Optional key to compare objects by specific property
   *
   * @throws {BadRequestException} When target array doesn't contain all required items
   *
   * @example
   * // Simple comparison
   * this.assertContainsAll([1, 2, 3], [2, 3]); // OK
   * this.assertContainsAll([1, 2], [2, 3, 4]); // Throws - missing 3 and 4
   *
   * @example
   * // Object comparison by key
   * this.assertContainsAll(playlistIds, requiredIds, 'Missing episodes');
   * this.assertContainsAll(episodes, required, 'Missing episodes', 'id');
   */
  assertContainsAll<T>(
    array: T[],
    requiredItems: T[],
    message: string = 'Not all required items are present',
    key?: keyof T,
  ): asserts array is T[] {
    const allFound = requiredItems.every((item) => {
      if (key) {
        const itemValue = item[key];
        return array.some((item2) => item2[key] === itemValue);
      }
      return array.includes(item);
    });
    if (!allFound) {
      throw new BadRequestException(message);
    }
  }

  /**
   * Asserts that array contains exactly one of the required items
   *
   * Validates that target array contains exactly one item from required items array.
   * Useful for "for_any" type validations where exactly one option must be selected.
   *
   * @template T - Type of array items
   * @param array - Target array to check (e.g., user's selected items)
   * @param requiredItems - Array of acceptable items
   * @param message - Custom error message (default: 'Must provide exactly one required item')
   * @param key - Optional key to compare objects by specific property
   *
   * @throws {BadRequestException} When array contains zero or more than one required item
   *
   * @example
   * // Simple comparison
   * this.assertContainsExactlyOne([2], [1, 2, 3]); // OK - exactly one match
   * this.assertContainsExactlyOne([5], [1, 2, 3]); // Throws - no matches
   * this.assertContainsExactlyOne([1, 2], [1, 2, 3]); // Throws - two matches
   *
   * @example
   * // Object comparison by key
   * this.assertContainsExactlyOne(selectedItems, wishlistItems, 'Select one', 'id');
   */
  assertContainsExactlyOne<T>(
    array: T[],
    requiredItems: T[],
    message: string = 'Must provide exactly one required item',
    key?: keyof T,
  ): T {
    const matches = array.filter((item) => {
      if (key) {
        const itemValue = item[key];
        return requiredItems.some((r) => r[key] === itemValue);
      }
      return requiredItems.includes(item);
    });
    if (matches.length !== 1) {
      throw new BadRequestException(message);
    }
    return matches[0];
  }

  /**
   * Asserts that condition is true
   */
  assert(
    condition: boolean,
    message: string = 'Validation failed',
  ): asserts condition is true {
    if (!condition) {
      throw new BadRequestException(message);
    }
  }

  assertWithinTimeFromDate(
    date: Date | string | number | null | undefined,
    mode: 'start' | 'end',
    seconds?: number,
    message?: string,
  ): boolean | void {
    if (date === null || date === undefined) {
      return;
    }
    const boundary =
      date instanceof Date ? date.getTime() : new Date(date).getTime();
    if (Number.isNaN(boundary)) {
      throw new BadRequestException(message || 'Invalid date');
    }
    const now = Date.now();
    if (mode === 'end') {
      if (now > boundary) {
        if (message === undefined) {
          return false;
        }
        throw new BadRequestException(message);
      }
      return true;
    }
    if (seconds === undefined || seconds < 0 || !Number.isFinite(seconds)) {
      throw new BadRequestException(
        'seconds must be a non-negative finite number when mode is "start"',
      );
    }
    const deadline = boundary + seconds * 1000;
    if (now > deadline) {
      if (message === undefined) {
        return false;
      }
      throw new BadRequestException(message);
    }
    return true;
  }
}
