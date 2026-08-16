import { Param } from '@nestjs/common';
import { UniUrlDtoPipe } from '@pipes';

/**
 * Custom parameter decorator that combines @Param with UniUrlDtoPipe for DTO validation
 *
 * Simplifies the usage of parameter validation by automatically applying the UniParamsPipe
 * to validate and transform parameter values using DTO classes.
 *
 * @template T - The type of DTO class to use for validation
 * @param dtoClass - Constructor function of the DTO class for validation
 * @param paramName - Name of the parameter to extract from the request
 * @returns Parameter decorator that validates the parameter using the specified DTO
 *
 * @example
 * '@Get(':id')'
 * findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
 *   // id is guaranteed to be a positive number
 * }
 */
export function ParamDto<T>(
  dtoClass: new (data?: any) => T,
  paramName: string,
) {
  return Param(paramName, new UniUrlDtoPipe(dtoClass, 'params'));
}
