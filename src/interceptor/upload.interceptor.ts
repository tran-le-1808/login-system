import {
  BadRequestException,
  NestInterceptor,
  Type,
  mixin,
} from '@nestjs/common';

import { FilesInterceptor } from '@nestjs/platform-express';

import { diskStorage } from 'multer';

export function UploadFilesInterceptor(
  fieldName = 'files',
  maxCount = 10,
): Type<NestInterceptor> {
  return mixin(
    FilesInterceptor(fieldName, maxCount, {
      storage: diskStorage({
        destination: './uploads',

        filename: (req, file, callback) => {
          const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

          const extension = file.originalname.split('.').pop();

          callback(null, `${uniqueName}.${extension}`);
        },
      }),

      limits: {
        fileSize: 1024 * 1024 * 50, // 50MB
      },

      fileFilter: (req, file, callback) => {
        const allowedMimeTypes = [
          //
          // IMAGES
          //
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif',

          //
          // VIDEOS
          //
          'video/mp4',
          'video/quicktime',
          'video/x-msvideo',

          //
          // FILES
          //
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/plain',
          'application/zip',
        ];

        if (allowedMimeTypes.includes(file.mimetype)) {
          callback(null, true);
        } else {
          callback(new BadRequestException('Unsupported file type'), false);
        }
      },
    }),
  );
}
