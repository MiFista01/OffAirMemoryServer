import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';
import { Logger } from 'winston';

/**
 * Global errors filter for handling HTTP exceptions and application-wide error management
 *
 * Provides global error handling functionality including HTTP exception processing,
 * comprehensive error logging with request context, status code management,
 * and standardized error response formatting for unhandled application errors.
 *
 * @see {@link DefaultLogMsg} for logging functionality
 * @see {@link HttpException} for HTTP error handling
 */
@Catch(HttpException)
export class GlobalErrorsFilter
  extends DefaultLogMsg
  implements ExceptionFilter
{
  protected readonly tag = 'Error';
  constructor(logger: Logger) {
    super(logger);
  }
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const status = exception.getStatus();
    const bare = exception.message ?? '';
    // Browser / probe hitting API root — not an app fault.
    if (status === 404 && /^Cannot GET \//i.test(bare)) {
      this.resMsg(ctx, status, { message: bare });
      return;
    }
    // Intentional encode abort while waiting for the guide — warn, not error spam.
    if (status === 400 && /air-grid-hold/i.test(bare)) {
      this.logMessage('warn', 'air-grid-hold', {
        msg: `${bare} - Request: ${this.reqMsg(ctx)}`,
      });
      this.resMsg(ctx, status, { message: bare });
      return;
    }
    const msg = `${bare} - Request: ${this.reqMsg(ctx)} - Status: ${status}`;
    this.logMessage('error', 'Global Exception', {
      error: bare,
      msg: msg,
    });
    this.resMsg(ctx, status, { message: bare });
  }
}
