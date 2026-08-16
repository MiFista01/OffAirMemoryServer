import { ArgumentsHost, Catch, ExceptionFilter, Inject } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';
import { Logger } from 'winston';

/**
 * Throttler log filter for handling rate limiting exceptions and request throttling
 *
 * Provides rate limiting error handling functionality including ThrottlerException
 * processing, comprehensive request logging, 429 status code management,
 * and detailed monitoring for API abuse prevention and fair resource usage.
 *
 * @see {@link DefaultLogMsg} for logging functionality
 * @see {@link ThrottlerException} for rate limiting error handling
 */
@Catch(ThrottlerException)
export class ThrottlerLogFilter
  extends DefaultLogMsg
  implements ExceptionFilter
{
  protected readonly tag = 'Rate-Limit';
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER)
    protected readonly logger: Logger,
  ) {
    super(logger);
  }
  catch(exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const msg = `${exception.message} - Request: ${this.reqMsg(ctx)}`;
    this.logMessage('warn', 'Too many requests', {
      error: exception.message,
      msg: msg,
    });
    this.resMsg(ctx, 429, {
      statusCode: 429,
      message: exception.message,
      timestamp: new Date().toISOString(),
      path: this.reqMsg(ctx),
    });
  }
}
