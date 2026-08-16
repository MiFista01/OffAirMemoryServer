import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';
import { QueryFailedError } from 'typeorm';
import { Logger } from 'winston';

/**
 * Database query exception filter for handling TypeORM database errors
 *
 * Provides database error handling functionality including QueryFailedError
 * processing, user-friendly error message mapping, HTTP status code
 * determination, and comprehensive logging for database constraint
 * violations and query failures with detailed error categorization.
 *
 * @see {@link DefaultLogMsg} for logging functionality
 * @see {@link QueryFailedError} for TypeORM error handling
 */
@Catch(QueryFailedError)
export class DBQueryFilter extends DefaultLogMsg implements ExceptionFilter {
  userMessage = 'Database error occurred';
  statusCode = 500;
  protected readonly tag = 'DB-Error';
  constructor(logger: Logger) {
    super(logger);
  }
  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();

    switch ((exception as any).code) {
      case 'ER_DUP_ENTRY': // duplicate key
        this.userMessage = 'Resource already exists';
        this.statusCode = 409;
        break;
      case 'ER_NO_REFERENCED_ROW_2': // foreign key violation
        this.userMessage = 'Referenced resource not found';
        this.statusCode = 400;
        break;
      case 'ER_NO_DEFAULT_FOR_FIELD': // not null violation
        {
          const field =
            /Field '([^']+)' doesn't have a default value/i.exec(
              exception.message,
            )?.[1] ?? null;
          this.userMessage = field
            ? `Required field is missing: ${field}`
            : 'Required field is missing';
          this.statusCode = 400;
        }
        break;
      case 'ER_CHECK_CONSTRAINT_VIOLATED': // check constraint violation
        this.userMessage = 'Invalid data provided';
        this.statusCode = 400;
        break;
    }
    const msg = `${this.userMessage} - Request: ${this.reqMsg(ctx)}`;

    this.logMessage('error', 'Database error occurred', {
      error: exception.message,
      msg: msg,
    });
    this.resMsg(ctx, this.statusCode, {
      message: this.userMessage,
    });
  }
}
