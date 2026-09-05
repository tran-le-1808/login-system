// src/ai/ai.gateway.ts

import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';

import { AIService } from './ai.service';

interface SocketData {
  userId?: string;
  user?: {
    _id?: string;
  };
}

interface AIMessagePayload {
  conversationId: string;
  content: string;
}

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class AIGateway {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly aiService: AIService) {}

  @SubscribeMessage('aiMessage')
  async handleAIMessage(
    @ConnectedSocket()
    client: Socket,

    @MessageBody()
    payload: AIMessagePayload,
  ) {
    try {
      const userId = this.getUserId(client);

      if (!userId) {
        client.emit('aiMessageError', {
          message: 'Unauthorized',
        });

        return;
      }

      const { conversationId, content } = payload;

      if (!conversationId || !content?.trim()) {
        client.emit('aiMessageError', {
          message: 'conversationId and content are required',
        });

        return;
      }

      // START
      client.emit('aiMessageStart', {
        conversationId,
      });

      await this.aiService.streamMessage(
        userId,

        conversationId,

        content.trim(),

        (chunk) => {
          client.emit('aiMessageChunk', {
            conversationId,

            chunk,
          });
        },
      );

      // COMPLETE
      client.emit('aiMessageComplete', {
        conversationId,
      });
    } catch (error: unknown) {
      console.error('AI message error:', error);

      const message =
        error instanceof Error ? error.message : 'AI request failed';

      client.emit('aiMessageError', {
        conversationId: payload?.conversationId,
        message,
      });
    }
  }

  private getUserId(client: Socket): string | null {
    const data = client.data as SocketData;

    return data.userId ?? data.user?._id ?? null;
  }
}
