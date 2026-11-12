import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { ChatService } from './chat.service';
import { MessageType } from './entities/message.entity';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import type { RequestWithUser } from 'src/auth/interfaces/request-with-user.interface';
import { UploadFilesInterceptor } from 'src/interceptor/upload.interceptor';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';

/** Giới hạn của Cloudinary (gói miễn phí): ảnh / tài liệu 10MB, video 100MB */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export interface SendMessageBody {
  senderId: string;

  receiverId?: string;

  conversationId?: string;

  text?: string;

  type?: MessageType;

  replyTo?: string;
}

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  /** Đẩy các tệp đính kèm lên Cloudinary, trả về danh sách attachment để lưu vào tin nhắn */
  private async uploadAttachments(files: Express.Multer.File[] = []) {
    for (const f of files) {
      const isVideo = f.mimetype.startsWith('video/');
      const max = isVideo ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
      if (f.size > max) {
        throw new BadRequestException(
          `Tệp "${f.originalname}" vượt quá ${max / 1024 / 1024}MB`,
        );
      }
    }
    try {
      return await Promise.all(
        files.map(async (file) => {
          const uploaded = await this.cloudinaryService.uploadChatFile(file);
          // PDF / ZIP: phát qua route tải có chữ ký (đường dẫn tương đối, frontend tự ghép API URL)
          const url =
            uploaded.resource_type === 'raw' &&
            CloudinaryService.needsSignedDelivery(uploaded.public_id)
              ? `/chat/files?id=${encodeURIComponent(uploaded.public_id)}`
              : uploaded.secure_url;
          return {
            url,
            name: file.originalname,
            type: file.mimetype,
            size: file.size,
          };
        }),
      );
    } catch (err) {
      this.logger.error(
        `Upload Cloudinary thất bại: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        'Không tải được tệp lên Cloudinary, vui lòng thử lại',
      );
    }
  }

  @Post('send-message')
  @UseInterceptors(UploadFilesInterceptor())
  async sendMessage(
    @Req() req: RequestWithUser,
    @UploadedFiles()
    files: Express.Multer.File[],

    @Body()
    body: SendMessageBody,
  ) {
    return this.chatService.sendMessage({
      senderId: req.user._id,
      receiverId: body.receiverId || undefined,
      conversationId: body.conversationId || undefined,
      text: body.text,
      type: body.type,
      replyTo: body.replyTo,
      attachments: await this.uploadAttachments(files),
    });
  }

  @Get('conversations')
  async getConversations(
    @Query('userId') userId: string,

    @Query('page') page = 1,

    @Query('limit') limit = 10,

    @Query('search') search = '',
  ) {
    return this.chatService.getConversations({
      userId,
      page: Number(page),
      limit: Number(limit),
      search,
    });
  }

  @Get('messages/:conversationId')
  async getMessages(
    @Param('conversationId') conversationId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.chatService.getMessages(
      conversationId,
      limit ? Number(limit) : 20,
      before,
    );
  }

  @Post('create-group')
  async createGroup(
    @Body()
    body: {
      adminId: string;

      groupName: string;

      participants: string[];

      groupAvatar?: string;
    },
  ) {
    return this.chatService.createGroup(body);
  }

  @Post('create-conversation')
  async createConversation(
    @Req()
    req: RequestWithUser,

    @Body()
    body: {
      receiverId: string;
    },
  ) {
    return this.chatService.createConversation(
      req.user._id,

      body.receiverId,
    );
  }
}
