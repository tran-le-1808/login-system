import { Injectable } from '@nestjs/common';
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
} from 'cloudinary';
import * as streamifier from 'streamifier';

@Injectable()
export class CloudinaryService {
  constructor() {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  uploadFile(file: Express.Multer.File): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'avatars',
          transformation: [
            { width: 300, height: 300, crop: 'fill', gravity: 'face' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (
          error: UploadApiErrorResponse | undefined,
          result: UploadApiResponse | undefined,
        ) => {
          if (error) {
            // Bọc object error từ Cloudinary vào instance của Error class
            return reject(
              new Error(error.message || 'Upload to Cloudinary failed'),
            );
          }
          if (!result) {
            return reject(
              new Error('Upload to Cloudinary failed: No result returned'),
            );
          }
          resolve(result);
        },
      );

      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  /** Thư mục chứa tệp đính kèm tin nhắn */
  static readonly CHAT_FOLDER = 'chat-zone/messages';

  /**
   * Tài khoản Cloudinary mới mặc định CHẶN phát trực tiếp PDF / ZIP (trả 401).
   * Các tệp này được phát qua link tải có chữ ký (xem signedRawDownloadUrl).
   */
  static needsSignedDelivery(fileName: string): boolean {
    return /\.(pdf|zip)$/i.test(fileName);
  }

  /** Link tải có chữ ký (hết hạn sau `ttlSeconds`) cho tệp "raw" — vượt qua giới hạn PDF / ZIP */
  signedRawDownloadUrl(publicId: string, ttlSeconds = 600): string {
    return cloudinary.utils.private_download_url(publicId, '', {
      resource_type: 'raw',
      type: 'upload',
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  }

  /**
   * Tải 1 tệp đính kèm tin nhắn (ảnh / video / tài liệu) lên Cloudinary.
   * - Ảnh  -> resource_type "image" (giữ nguyên ảnh gốc, không cắt)
   * - Video -> resource_type "video"
   * - Còn lại (pdf, docx, xlsx, zip, txt…) -> "raw" để tải về đúng tệp gốc
   */
  uploadChatFile(file: Express.Multer.File): Promise<UploadApiResponse> {
    const resourceType: 'image' | 'video' | 'raw' = file.mimetype.startsWith(
      'image/',
    )
      ? 'image'
      : file.mimetype.startsWith('video/')
        ? 'video'
        : 'raw';

    // Tên gốc an toàn cho public_id (bỏ dấu, ký tự lạ). Tệp "raw" cần giữ phần mở rộng.
    const dot = file.originalname.lastIndexOf('.');
    const ext = dot > 0 ? file.originalname.slice(dot + 1).toLowerCase() : '';
    const base =
      (dot > 0 ? file.originalname.slice(0, dot) : file.originalname)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'file';
    const unique = `${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    const publicId =
      resourceType === 'raw' && ext
        ? `${base}_${unique}.${ext}`
        : `${base}_${unique}`;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: CloudinaryService.CHAT_FOLDER,
          resource_type: resourceType,
          public_id: publicId,
          // Video lớn: tải theo từng phần 6MB
          ...(resourceType === 'video' ? { chunk_size: 6_000_000 } : {}),
        },
        (
          error: UploadApiErrorResponse | undefined,
          result: UploadApiResponse | undefined,
        ) => {
          if (error) {
            return reject(
              new Error(error.message || 'Upload to Cloudinary failed'),
            );
          }
          if (!result) {
            return reject(
              new Error('Upload to Cloudinary failed: No result returned'),
            );
          }
          resolve(result);
        },
      );

      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  /**
   * Xoá tệp đính kèm khỏi Cloudinary (thu hồi tin nhắn). Suy public_id & loại tài nguyên từ URL
   * đã lưu: link Cloudinary trực tiếp hoặc route `/chat/files?id=...` (PDF/ZIP). Chỉ xoá trong
   * thư mục tin nhắn. Trả về true nếu đã gửi lệnh xoá; không ném lỗi (làm nền, có log).
   */
  async destroyChatAttachment(url: string): Promise<boolean> {
    let publicId: string | null = null;
    let resourceType = 'image' as 'image' | 'video' | 'raw';
    const viaRoute = url.match(/\/chat\/files\?id=([^&]+)/);
    if (viaRoute) {
      publicId = decodeURIComponent(viaRoute[1]);
      resourceType = 'raw';
    } else {
      const m = url.match(
        /\/(image|video|raw)\/upload\/(?:v\d+\/)?(chat-zone\/messages\/[^?#]+)/,
      );
      if (m) {
        resourceType = m[1] as typeof resourceType;
        publicId = decodeURIComponent(m[2]);
        // image / video: public_id không kèm phần mở rộng; raw: có
        if (resourceType !== 'raw')
          publicId = publicId.replace(/\.[A-Za-z0-9]+$/, '');
      }
    }
    if (!publicId || !publicId.startsWith(CloudinaryService.CHAT_FOLDER + '/'))
      return false;
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        invalidate: true,
      });
      return true;
    } catch {
      return false;
    }
  }
}
