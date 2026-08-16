import { fileCleanerKey } from '@constants';
import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { FileCleanerInterceptor } from '@interceptors';

/**
 * File cleaner decorator for automatic file cleanup operations
 *
 * Provides file cleanup functionality including automatic file deletion
 * after operations, folder-based file organization, and metadata-driven
 * cleanup configuration with interceptor-based execution.
 *
 * @param folder - Target folder path for file operations
 * @param name - File name or identifier for cleanup operations
 *
 * @see {@link FileCleanerInterceptor} for cleanup implementation
 * @see {@link SetMetadata} for metadata configuration
 */
export const Cleaner = (folder: string, name: string) => {
  return applyDecorators(
    SetMetadata(fileCleanerKey, { folder, fieldName: name, cleanUp: true }),
    UseInterceptors(FileCleanerInterceptor),
  );
};
