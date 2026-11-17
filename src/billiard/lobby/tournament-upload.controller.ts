/**
 * Tải ảnh bìa giải đấu Bida lên Cloudinary (REST multipart — socket không hợp để gửi tệp).
 * Trả về URL Cloudinary; khi tạo giải, server chỉ chấp nhận URL trong thư mục ảnh giải đấu của hệ thống.
 */
import {
  BadRequestException,
  Controller,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import type { RequestWithUser } from 'src/auth/interfaces/request-with-user.interface';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';

export const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = /^image\/(jpeg|jpg|png|webp)$/;
/** Chống spam: tối đa 10 ảnh / 10 phút / người */
const WINDOW_MS = 10 * 60_000;
const MAX_IN_WINDOW = 10;

@Controller('billiard/tournaments')
export class BilliardTournamentUploadController {
  private readonly logger = new Logger('BilliardUpload');
  private recent = new Map<string, number[]>();

  constructor(private readonly cloudinary: CloudinaryService) {}

  @Post('thumbnail')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: THUMBNAIL_MAX_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        // không nhận SVG (có thể chứa script)
        if (!ALLOWED.test(file.mimetype))
          return cb(
            new BadRequestException('Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP'),
            false,
          );
        cb(null, true);
      },
    }),
  )
  async upload(
    @Req() req: RequestWithUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string; width: number; height: number }> {
    if (!file) throw new BadRequestException('Chưa chọn ảnh');
    const userId = String(req.user._id);
    const now = Date.now();
    const times = (this.recent.get(userId) ?? []).filter(
      (t) => now - t < WINDOW_MS,
    );
    if (times.length >= MAX_IN_WINDOW)
      throw new HttpException(
        'Bạn tải ảnh quá nhiều, vui lòng thử lại sau',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    times.push(now);
    this.recent.set(userId, times);
    try {
      const r = await this.cloudinary.uploadTournamentThumbnail(file);
      return { url: r.secure_url, width: r.width, height: r.height };
    } catch (e) {
      this.logger.error(`Tải ảnh giải đấu thất bại: ${(e as Error).message}`);
      throw new InternalServerErrorException(
        'Không tải được ảnh lên, vui lòng thử lại',
      );
    }
  }
}
