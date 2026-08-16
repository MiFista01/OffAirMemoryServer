import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, Observable, tap } from 'rxjs';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';
import { Logger } from 'winston';

/**
 * Logging interceptor for request/response monitoring and performance tracking
 *
 * Provides request logging functionality including selective endpoint logging
 * via metadata configuration, request duration measurement, comprehensive
 * request information extraction, and success response logging with
 * performance metrics and detailed request context.
 *
 * @see {@link Reflector} for metadata access
 * @see {@link NestInterceptor} for interceptor implementation
 * @see {@link ShouldLog} decorator for logging control
 */
@Injectable()
export class LoggingInterceptor
  extends DefaultLogMsg
  implements NestInterceptor
{
  protected readonly tag = 'Error';
  constructor(
    logger: Logger,
    private reflector: Reflector,
  ) {
    super(logger);
  }
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const shouldLog = this.reflector.get<boolean>(
      'shouldLog',
      context.getHandler(),
    );

    if (!shouldLog) {
      return next.handle();
    }

    const startTime = Date.now();
    const className = context.getClass().name;
    const methodName = context.getHandler().name;
    const fullMethodName = `${className}.${methodName}`;

    const requestInfo = this.reqMsg(context.switchToHttp());

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        this.logMessage(
          'info',
          `Request completed (${fullMethodName})`,
          {
            duration_ms: duration,
            msg: requestInfo,
          },
          'Success',
        );
      }),
      catchError((err) => {
        const duration = Date.now() - startTime;
        this.logMessage(
          'error',
          `Request failed (${fullMethodName})`,
          {
            duration_ms: duration,
            msg: requestInfo,
          },
          'Error',
        );
        throw err;
      }),
    );
  }
}
