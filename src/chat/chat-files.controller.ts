import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';

/** public_id hợp lệ của tệp đính kèm: chỉ trong thư mục tin nhắn, không ký tự lạ */
const SAFE_ID = new RegExp(
  `^${CloudinaryService.CHAT_FOLDER.replace(/[/-]/g, '\\$&')}/[A-Za-z0-9_-]+\\.(pdf|zip)$`,
  'i',
);

/**
 * Phát tệp PDF / ZIP lưu trên Cloudinary.
 * Cloudinary chặn link trực tiếp của 2 loại này, nên route chuyển hướng sang
 * link tải có chữ ký, hết hạn sau 10 phút.
 *
 * Route KHÔNG yêu cầu đăng nhập: link được mở bằng thẻ <a> ở tab mới (không gửi
 * header Authorization). public_id có hậu tố ngẫu nhiên, khó đoán như một link
 * Cloudinary thông thường.
 */
@Controller('chat/files')
export class ChatFilesController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  @Get()
  download(@Query('id') id: string, @Res() res: Response) {
    if (!id || !SAFE_ID.test(id)) {
      throw new BadRequestException('Tệp không hợp lệ');
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.redirect(302, this.cloudinaryService.signedRawDownloadUrl(id));
  }
}
