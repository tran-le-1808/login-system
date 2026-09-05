import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AIService } from './ai.service';
import { CreateConversationDto } from './dtos/create-conversation.dto';
import { SendMessageDto } from './dtos/send-message.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import type { RequestWithUser } from 'src/auth/interfaces/request-with-user.interface';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AIController {
  constructor(private readonly aiService: AIService) {}

  /**
   * CREATE CONVERSATION
   */
  @Post('conversations')
  async createConversation(
    @Req() req: RequestWithUser,

    @Body()
    dto: CreateConversationDto,
  ) {
    const userId = this.getUserId(req);

    return this.aiService.createConversation(
      userId,

      dto,
    );
  }

  /**
   * GET CONVERSATIONS
   */
  @Get('conversations')
  async getConversations(@Req() req: RequestWithUser) {
    const userId = this.getUserId(req);

    return this.aiService.getConversations(userId);
  }

  /**
   * GET MESSAGES
   */
  @Get('conversations/:conversationId/messages')
  async getMessages(
    @Req() req: RequestWithUser,
    @Param('conversationId') conversationId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = this.getUserId(req);

    return this.aiService.getMessages(
      userId,
      conversationId,
      before,
      limit ? Number(limit) : 20,
    );
  }

  /**
   * NON-STREAM MESSAGE
   *
   * Chủ yếu để test API.
   *
   * Production nên dùng Socket.IO
   * streaming.
   */
  @Post('conversations/:conversationId/messages')
  async sendMessage(
    @Req() req: RequestWithUser,

    @Param('conversationId')
    conversationId: string,

    @Body()
    dto: SendMessageDto,
  ) {
    const userId = this.getUserId(req);

    return this.aiService.sendMessage(
      userId,

      conversationId,

      dto.content,
    );
  }

  private getUserId(req: RequestWithUser): string {
    const user = req.user;

    const userId = user?._id;

    if (!userId) {
      throw new Error('User is not authenticated');
    }

    return String(userId);
  }
}
