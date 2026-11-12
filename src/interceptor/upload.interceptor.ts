import {
  BadRequestException,
  NestInterceptor,
  Type,
  mixin,
} from '@nestjs/common';

import { FilesInterceptor } from '@nestjs/platform-express';

import { memoryStorage } from 'multer';

/**
 * Nhận tệp vào bộ nhớ (buffer) rồi controller đẩy thẳng lên Cloudinary.
 * Không ghi ra ổ đĩa: ổ đĩa của server (Render…) bị xoá mỗi lần deploy.
 */
export function UploadFilesInterceptor(
  fieldName = 'files',
  maxCount = 10,
): Type<NestInterceptor> {
  return mixin(
    FilesInterceptor(fieldName, maxCount, {
      storage: memoryStorage(),

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
