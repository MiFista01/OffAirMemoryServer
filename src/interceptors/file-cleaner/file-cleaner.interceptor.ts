import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { catchError, map, Observable, throwError } from 'rxjs';
import * as fs from 'fs';
import { Reflector } from '@nestjs/core';
import { FileCleanerOptions } from '@app-types';
import { fileCleanerKey } from '@constants';
import { Cleaner } from '@decorators';
import { Logger } from 'winston';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';

/**
 * File cleaner interceptor for automatic file cleanup on request failures
 *
 * Provides file cleanup functionality including automatic file deletion
 * on error conditions, metadata-driven cleanup configuration, file path
 * validation, and comprehensive error logging for temporary file
 * management and resource cleanup operations.
 *
 * @see {@link FileCleanerOptions} for cleanup configuration
 * @see {@link Reflector} for metadata access
 * @see {@link Cleaner} decorator which work in pair with this interceptor
 */
@Injectable()
export class FileCleanerInterceptor
  extends DefaultLogMsg
  implements NestInterceptor
{
  protected readonly tag = 'Files';
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) protected readonly logger: Logger,
    private reflector: Reflector,
  ) {
    super(logger);
  }
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest();

    const className = context.getClass().name;
    const methodName = context.getHandler().name;
    const fullMethodName = `${className}.${methodName}`;
    const requestInfo = this.reqMsg(ctx);
    const message = requestInfo || fullMethodName;

    const fileCleanerOptions = this.reflector.get<FileCleanerOptions>(
      fileCleanerKey,
      context.getHandler(),
    );

    return next.handle().pipe(
      map((data) => ({
        success: true,
        message: data?.message || 'Operation successful',
        data: data?.data !== undefined ? data.data : data,
      })),
      catchError((err) => {
        const files = request.files;
        const error = err.message;
        if (files && fileCleanerOptions?.cleanUp) {
          this.logMessage('error', 'Cleaning files', {
            error: error,
            msg:
              message +
              ` - Error: ${error} - Files: ${JSON.stringify(files)} - Options: ${JSON.stringify(fileCleanerOptions)}`,
          });
          this.cleanFiles(files, fileCleanerOptions);
        }
        return throwError(() => err);
      }),
    );
  }
  private cleanFiles(
    files: Record<string, Express.Multer.File | Express.Multer.File[]>,
    options: FileCleanerOptions,
  ): void {
    const fieldName = options.fieldName ?? (options as { name?: string }).name;
    if (!fieldName) {
      return;
    }
    try {
      const fieldFiles = files[`${fieldName}[]`] ?? files[fieldName];

      if (!fieldFiles) {
        return;
      }

      const filesArray = Array.isArray(fieldFiles) ? fieldFiles : [fieldFiles];

      for (const file of filesArray) {
        if (file?.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    } catch (error) {
      this.logMessage(
        'error',
        'Error cleaning files',
        {
          msg: `Error cleaning files: ${(error as Error).message}`,
        },
        'Files',
      );
    }
  }
}
