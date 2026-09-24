import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { AIService } from './ai.service';

interface AIMessagePayload {
  conversationId: string;
  content: string;
}

interface JwtPayload {
  sub?: string;
  _id?: string;
  userId?: string;
}

interface SocketAuth {
  token?: unknown;
}

@WebSocketGateway({
  cors: {
    origin: [process.env.WEB_URL ?? ''],
    credentials: true,
  },
})
export class AIGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly aiService: AIService,
    private readonly jwtService: JwtService,
  ) {}

  handleConnection(client: Socket): void {
    console.log(`[AIGateway] Connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    console.log(`[AIGateway] Disconnected: ${client.id}`);
  }

  @SubscribeMessage('aiMessage')
  async handleAIMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: AIMessagePayload,
  ): Promise<void> {
    console.log('[AIGateway] aiMessage received:', client.id);
    console.log('[AIGateway] auth:', client.handshake.auth);
    console.log('[AIGateway] payload:', payload);

    try {
      const userId = await this.getUserId(client);
      console.log('🚀 ~ AIGateway ~ handleAIMessage ~ userId:', userId);

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

      client.emit('aiMessageStart', {
        conversationId,
      });

      const savedAiMessage = await this.aiService.streamMessage(
        userId,
        conversationId,
        content.trim(),
        (chunk: string) => {
          client.emit('aiMessageChunk', {
            conversationId,
            chunk,
          });
        },
      );

      console.log('[AIGateway] AI message completed:', conversationId);

      client.emit('aiMessageComplete', {
        conversationId,
        message: savedAiMessage,
      });
    } catch (error: unknown) {
      console.error('[AIGateway] AI message error:', error);

      const message =
        error instanceof Error ? error.message : 'AI request failed';

      client.emit('aiMessageError', {
        conversationId: payload?.conversationId,
        message,
      });
    }
  }

  private async getUserId(client: Socket): Promise<string | null> {
    const auth = client.handshake.auth as SocketAuth;

    if (typeof auth.token !== 'string' || !auth.token) {
      return null;
    }

    const token = auth.token.replace(/^Bearer\s+/i, '');

    try {
      const decoded: unknown = await this.jwtService.verifyAsync(token);

      if (typeof decoded !== 'object' || decoded === null) {
        return null;
      }

      const payload = decoded as JwtPayload;

      return payload.sub ?? payload._id ?? payload.userId ?? null;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'JWT verification failed';

      console.error('[AIGateway] JWT verification error:', message);

      return null;
    }
  }
}
