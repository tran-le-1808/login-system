// src/ai/ai.gateway.ts

import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
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
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class AIGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly aiService: AIService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Tự động chạy ngay khi Client khởi tạo kết nối Socket
   */
  async handleConnection(client: Socket) {
    try {
      let token = '';
      // Trích xuất từ Cookie nếu chưa tìm thấy trong auth/header
      if (typeof client.handshake.headers.cookie === 'string') {
        const cookies = client.handshake.headers.cookie
          .split(';')
          .reduce<Record<string, string>>((acc, cookie) => {
            const [key, value] = cookie.trim().split('=');
            if (key && value) {
              acc[key] = value;
            }
            return acc;
          }, {});

        token = cookies['token'];
      }

      if (!token) {
        console.warn(
          `[AIGateway] Connection rejected: Missing token (${client.id})`,
        );
        return;
      }

      const cleanToken = token.replace(/^Bearer\s+/i, '');
      const decoded: unknown = await this.jwtService.verifyAsync(cleanToken);

      // Cast sang interface mong muốn sau khi đã verify
      const payload = decoded as {
        sub?: string;
        _id?: string;
        userId?: string;
      };
      const userId = payload.sub || payload._id || payload.userId;

      client.data = {
        userId,
        user: payload,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Auth failed';
      console.error(`[AIGateway] Auth Error (${client.id}):`, errorMessage);
    }
  }

  @SubscribeMessage('aiMessage')
  async handleAIMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: AIMessagePayload,
  ) {
    console.log(12345, client.data);
    try {
      const userId = this.getUserId(client);

      if (!userId) {
        client.emit('aiMessageError', { message: 'Unauthorized' });
        return;
      }

      const { conversationId, content } = payload;

      if (!conversationId || !content?.trim()) {
        client.emit('aiMessageError', {
          message: 'conversationId and content are required',
        });
        return;
      }

      // Phát sự kiện bắt đầu ngay lập tức
      client.emit('aiMessageStart', { conversationId });

      // Thực hiện stream
      const savedAiMessage = await this.aiService.streamMessage(
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
      console.log(
        '🚀 ~ AIGateway ~ handleAIMessage ~ savedAiMessage:',
        savedAiMessage,
      );
      console.log(
        '🚀 ~ AIGateway ~ handleAIMessage ~ conversationId:',
        conversationId,
      );

      // Phát sự kiện hoàn thành kèm tin nhắn đã tạo trong DB
      client.emit('aiMessageComplete', {
        conversationId,
        message: savedAiMessage,
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
