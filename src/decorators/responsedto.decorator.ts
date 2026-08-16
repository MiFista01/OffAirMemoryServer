import { ResponseDtoInterceptor } from '@interceptors';
import {
  applyDecorators,
  SetMetadata,
  Type,
  UseInterceptors,
} from '@nestjs/common';

export const RESPONSE_DTO_KEY = 'response-dto-class';

export function ResponseDto(dtoClass: Type<unknown>) {
  return applyDecorators(
    SetMetadata(RESPONSE_DTO_KEY, dtoClass),
    UseInterceptors(ResponseDtoInterceptor),
  );
}
