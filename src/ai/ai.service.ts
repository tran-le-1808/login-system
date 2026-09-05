// src/ai/ai.service.ts

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import type { AIMessage, AIProvider } from './providers/ai.provider';
import { AI_BOT_ID } from './schemas/ai-message.schema';
import {
  Conversation,
  ConversationDocument,
} from 'src/chat/entities/conversation.entity';
import {
  Message,
  MessageDocument,
  MessageType,
} from 'src/chat/entities/message.entity';
import { CreateConversationDto } from './dtos/create-conversation.dto';

@Injectable()
export class AIService {
  private readonly MAX_HISTORY = 20;

  constructor(
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,

    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,

    @Inject('AI_PROVIDER')
    private readonly aiProvider: AIProvider,
  ) {}

  /**
   * CREATE AI CONVERSATION
   */
  async createConversation(userId: string, dto: CreateConversationDto) {
    const conversation = await this.conversationModel.create({
      participants: [userId, AI_BOT_ID],
      isGroup: false,
      groupName: '',
      groupAvatar: '',
      groupDescription: '',
      adminId: userId,
      moderators: [],
      lastMessage: '',
      lastMessageAt: null,
      participantsSettings: [
        {
          userId,
          pinned: false,
          muted: false,
          hidden: false,
          blocked: false,
          deleted: false,
          lastSeenAt: new Date(),
          unreadCount: 0,
        },
        {
          userId: AI_BOT_ID,
          pinned: false,
          muted: false,
          hidden: false,
          blocked: false,
          deleted: false,
          lastSeenAt: new Date(),
          unreadCount: 0,
        },
      ],
      allowSendMessage: true,
      allowSendMedia: false,
      allowMemberInvite: false,
    });

    return {
      conversationId: conversation._id.toString(),
      title: dto.title || 'AI Assistant',
      provider: dto.provider || process.env.AI_PROVIDER || 'gemini',
      model: dto.model || this.getCurrentModel(),
    };
  }

  /**
   * GET USER AI CONVERSATIONS
   */
  async getConversations(userId: string) {
    return this.conversationModel
      .find({
        participants: {
          $all: [userId, AI_BOT_ID],
        },
      })
      .sort({
        lastMessageAt: -1,
      })
      .lean();
  }

  /**
   * GET MESSAGES
   */
  async getMessages(
    userId: string,
    conversationId: string,
    before?: string,
    limit = 20,
  ) {
    await this.validateConversation(userId, conversationId);

    const query: FilterQuery<MessageDocument> = {
      conversationId,
      deleted: false,
    };

    if (before) {
      query.createdAt = {
        $lt: new Date(before),
      };
    }

    const messages = await this.messageModel
      .find(query)
      .sort({
        createdAt: -1,
      })
      .limit(limit + 1)
      .lean();

    const hasMore = messages.length > limit;
    const slicedMessages = hasMore ? messages.slice(0, limit) : messages;

    // Get cursor from the oldest item before reversing
    const nextCursor =
      slicedMessages.length > 0
        ? slicedMessages[slicedMessages.length - 1].createdAt
        : null;

    const result = slicedMessages.reverse();

    return {
      messages: result,
      hasMore,
      nextCursor,
    };
  }

  /**
   * SEND AI MESSAGE - NON STREAM
   */
  async sendMessage(userId: string, conversationId: string, content: string) {
    await this.validateConversation(userId, conversationId);

    // 1. Lưu tin nhắn người dùng
    const userMessage = await this.messageModel.create({
      conversationId,
      senderId: userId,
      text: content,
      type: MessageType.TEXT,
      attachments: [],
      seen: true,
      deleted: false,
      replyTo: null,
    });

    await this.updateConversation(conversationId, content);

    // 2. Lấy ngữ cảnh và gọi AI
    const messages = await this.buildAIContext(conversationId);

    const response = await this.aiProvider.chat(messages, {
      temperature: 0.7,
      maxTokens: 2048,
    });

    // 3. Lưu tin nhắn AI
    const aiMessage = await this.messageModel.create({
      conversationId,
      senderId: AI_BOT_ID,
      text: response,
      type: MessageType.TEXT,
      attachments: [],
      seen: true,
      deleted: false,
      replyTo: null,
    });

    await this.updateConversation(conversationId, response);

    // 4. Trả về cả tin nhắn User và AI
    return {
      userMessage,
      aiMessage,
    };
  }

  /**
   * STREAM AI MESSAGE
   */
  async streamMessage(
    userId: string,
    conversationId: string,
    content: string,
    onChunk: (chunk: string) => void,
  ) {
    await this.validateConversation(userId, conversationId);

    await this.messageModel.create({
      conversationId,
      senderId: userId,
      text: content,
      type: MessageType.TEXT,
      attachments: [],
      seen: true,
      deleted: false,
      replyTo: null,
    });

    await this.updateConversation(conversationId, content);

    const messages = await this.buildAIContext(conversationId);

    let fullResponse = '';

    await this.aiProvider.stream(
      messages,
      (chunk) => {
        fullResponse += chunk;
        onChunk(chunk);
      },
      {
        temperature: 0.7,
        maxTokens: 2048,
      },
    );

    const aiMessage = await this.messageModel.create({
      conversationId,
      senderId: AI_BOT_ID,
      text: fullResponse,
      type: MessageType.TEXT,
      attachments: [],
      seen: true,
      deleted: false,
      replyTo: null,
    });

    await this.updateConversation(conversationId, fullResponse);

    return aiMessage;
  }

  /**
   * BUILD AI CONTEXT
   */
  private async buildAIContext(conversationId: string): Promise<AIMessage[]> {
    const dbMessages = await this.messageModel
      .find({
        conversationId,
        deleted: false,
      })
      .sort({
        createdAt: -1,
      })
      .limit(this.MAX_HISTORY)
      .lean();

    const chronologicalMessages = [...dbMessages].reverse();

    const context: AIMessage[] = [
      {
        role: 'system',
        content: `
You are a helpful AI assistant inside a chat application.

Rules:
- Answer clearly and concisely.
- Use Markdown when useful.
- If the user asks for code, provide clean and production-ready code.
- If you are unsure, say that you are unsure.
- Do not invent facts.
- The user may communicate in Vietnamese or English.
- Respond in the same language as the user.
        `.trim(),
      },
    ];

    for (const message of chronologicalMessages) {
      if (!message.text) {
        continue;
      }

      context.push({
        role: message.senderId === AI_BOT_ID ? 'assistant' : 'user',
        content: message.text,
      });
    }

    return context;
  }

  /**
   * VALIDATE CONVERSATION
   */
  private async validateConversation(userId: string, conversationId: string) {
    const conversation = await this.conversationModel.findOne({
      _id: conversationId,
      participants: {
        $all: [userId, AI_BOT_ID],
      },
    });

    if (!conversation) {
      throw new NotFoundException('AI conversation not found');
    }

    return conversation;
  }

  /**
   * UPDATE LAST MESSAGE
   */
  private async updateConversation(conversationId: string, message: string) {
    await this.conversationModel.updateOne(
      {
        _id: conversationId,
      },
      {
        $set: {
          lastMessage:
            message.length > 200 ? `${message.substring(0, 200)}...` : message,
          lastMessageAt: new Date(),
        },
      },
    );
  }

  private getCurrentModel() {
    return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }
}
