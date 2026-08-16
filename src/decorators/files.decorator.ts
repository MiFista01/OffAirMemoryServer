import {
  applyDecorators,
  InternalServerErrorException,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';

// TODO: validate MIME type and file extension

/**
 * Files upload decorator for handling multiple file uploads
 *
 * Provides image upload functionality including multiple file handling with
 * array support, automatic directory creation, random filename generation,
 * file extension preservation, and disk storage configuration with
 * customizable upload paths and file count limits.
 *
 * @param folder - Target folder path for file storage
 * @param name - Field name for the uploaded files array
 *
 * @see {@link FileFieldsInterceptor} for file handling implementation
 * @see {@link diskStorage} for storage configuration
 */
export const Files = (folder: string, name: string, maxCount: number = 10) => {
  return applyDecorators(
    UseInterceptors(
      FileFieldsInterceptor([{ name: `${name}[]`, maxCount: maxCount }], {
        storage: diskStorage({
          destination: (_req, _file, callback) => {
            const uploadPath = path.join(process.cwd(), `public/${folder}`);

            if (!fs.existsSync(uploadPath)) {
              fs.mkdir(uploadPath, { recursive: true }, () => {});
            }
            callback(null, uploadPath);
          },
          filename: (_req, file, callback) => {
            const randomName = Array(32)
              .fill(null)
              .map(() => Math.round(Math.random() * 16).toString(16))
              .join('');
            callback(null, `${randomName}${path.extname(file.originalname)}`);
          },
        }),
      }),
    ),
  );
};
