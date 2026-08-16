import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { MulterError } from 'multer';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';
import { Logger } from 'winston';

const multerErrorRequests: {
  [key: string]: { message: string; statusCode: number };
} = {
  LIMIT_FILE_SIZE: { message: 'File size exceeds the limit', statusCode: 413 },
  LIMIT_FILE_COUNT: {
    message: 'File count exceeds the limit',
    statusCode: 413,
  },
  LIMIT_FIELD_KEY: { message: 'Field key exceeds the limit', statusCode: 413 },
  LIMIT_FIELD_VALUE: {
    message: 'Field value exceeds the limit',
    statusCode: 413,
  },
  LIMIT_FIELD_COUNT: {
    message: 'Field count exceeds the limit',
    statusCode: 413,
  },
  LIMIT_UNEXPECTED_FILE: { message: 'Unexpected file', statusCode: 413 },
  LIMIT_PART_COUNT: {
    message: 'Part count exceeds the limit',
    statusCode: 413,
  },
  LIMIT_FIELD_PARTS: {
    message: 'Field parts exceeds the limit',
    statusCode: 413,
  },
  LIMIT_FIELD_FILE_COUNT: {
    message: 'Field file count exceeds the limit',
    statusCode: 413,
  },
  LIMIT_FIELD_FILE_SIZE: {
    message: 'Field file size exceeds the limit',
    statusCode: 413,
  },
};

/**
 * Multer exception filter for handling file upload errors and validation
 *
 * Provides file upload error handling functionality including MulterError
 * processing, comprehensive error code mapping, user-friendly error messages,
 * HTTP status code determination, and detailed logging for file upload
 * constraints and validation failures.
 *
 * @see {@link DefaultLogMsg} for logging functionality
 * @see {@link MulterError} for file upload error handling
 */
@Catch(MulterError)
export class MulterFilter extends DefaultLogMsg implements ExceptionFilter {
  protected readonly tag = 'Files';
  constructor(logger: Logger) {
    super(logger);
  }
  catch(exception: MulterError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const msg = `${exception.message} - Request: ${this.reqMsg(ctx)}`;
    const error = multerErrorRequests[exception.code];

    this.logMessage(
      'error',
      'File upload error',
      {
        error: exception.message,
        msg: msg,
      },
      'Files',
    );
    this.resMsg(ctx, error.statusCode, {
      message: error.message,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString(),
      path: this.reqMsg(ctx),
    });
  }
}
