import {
  Body,
  Controller,
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
  constructor(private readonly chatService: ChatService) {}

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
      attachments: files.map((file: Express.Multer.File) => ({
        url: `/uploads/${file.filename}`,

        name: file.originalname,

        type: file.mimetype,

        size: file.size,
      })),
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
