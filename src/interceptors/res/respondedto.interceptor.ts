import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Type,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { RESPONSE_DTO_KEY } from 'src/decorators/responsedto.decorator';
import { plainToInstance } from 'class-transformer';

@Injectable()
export class ResponseDtoInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const dtoClass = this.reflector.getAllAndOverride<Type<unknown>>(
      RESPONSE_DTO_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!dtoClass) return next.handle();
    return next.handle().pipe(
      map((data) =>
        plainToInstance(dtoClass, data, {
          excludeExtraneousValues: true,
          enableImplicitConversion: false,
        }),
      ),
    );
  }
}
