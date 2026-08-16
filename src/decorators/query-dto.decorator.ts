import { Query } from '@nestjs/common';
import { UniUrlDtoPipe } from '@pipes';

/**
 * Custom query parameter decorator that combines '@Query' with UniUrlDtoPipe for DTO validation
 *
 * Simplifies the usage of query parameter validation by automatically applying the UniUrlDtoPipe
 * to validate and transform query parameter values using DTO classes. Supports both simple values
 * and arrays with nested validation.
 *
 * @template T - The type of DTO class to use for validation
 * @template I - The type of DTO class for array item validation (when using arrays)
 * @param dtoClass - Constructor function of the DTO class for validation
 * @param paramName - Name of the query parameter to extract from the request
 * @param includesDto - Optional DTO class for validating individual array items
 * @returns Query parameter decorator that validates the parameter using the specified DTO
 *
 * @example
 * // Simple boolean query parameter
 * '@Get('channels')'
 * findChannels(@QueryDto(QueryBooleanDto, 'isActive') isActive: boolean) {
 *   // isActive is validated and typed as boolean
 * }
 *
 * @example
 * // Array query parameter with item validation
 * '@Get('users')'
 * findUsers(@QueryDto(QueryArrayDto, 'ids', ParamsNumbDto) ids: number[]) {
 *   // ids is validated as array of positive numbers
 *   // URL: /users?ids=1,2,3,4
 * }
 *
 * @example
 * // Optional query parameter
 * '@Get('search')'
 * search(@QueryDto(QueryBooleanDto, 'includeInactive') includeInactive?: boolean) {
 *   // includeInactive is optional and validated when present
 * }
 *
 * @throws {BadRequestException} When validation fails
 */
export function QueryDto<T, I>(
  dtoClass: new (data?: any) => T & { value: any },
  paramName: string,
  includesDto?: new (data?: any) => I & { value: any },
) {
  return Query(paramName, new UniUrlDtoPipe(dtoClass, 'query', includesDto));
}
