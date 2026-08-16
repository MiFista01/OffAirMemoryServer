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
    const msg = `${exception.message} - Request: ${this.reqMsg(ctx)} - Status: ${exception.getStatus()}`;
    this.logMessage('error', 'Global Exception', {
      error: exception.message,
      msg: msg,
    });
    this.resMsg(ctx, exception.getStatus(), { message: exception.message });
  }
}
