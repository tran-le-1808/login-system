import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';

import { InjectModel } from '@nestjs/mongoose';

import { Model } from 'mongoose';
import { Message, MessageDocument } from './entities/message.entity';
import {
  Conversation,
  ConversationDocument,
} from './entities/conversation.entity';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;
  private onlineUsers = new Map<string, string>();

  constructor(
    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,
    @InjectModel(Conversation.name)
    private conversationModel: Model<ConversationDocument>,
  ) {}

  private users = new Map<string, string>();

  handleConnection(client: Socket) {
    console.log(`Connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.users.forEach((socketId, userId) => {
      if (socketId === client.id) {
        this.users.delete(userId);
      }
    });

    console.log(`Disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinConversation')
  async handleJoinConversation(
    @MessageBody()
    conversationId: string,

    @ConnectedSocket()
    client: Socket,
  ) {
    await client.join(conversationId);
  }

  @SubscribeMessage('sendMessage')
  handleSendMessage(
    @MessageBody()
    data: {
      conversationId: string;
      receiverId: string;
      message: Message;
    },
  ) {
    this.server.to(data.conversationId).emit('newMessage', data.message);

    this.server.to(data.receiverId).emit('newMessage', data.message);
  }

  //
  // JOIN
  //
  @SubscribeMessage('join')
  async handleJoin(
    @MessageBody()
    userId: string,

    @ConnectedSocket()
    client: Socket,
  ) {
    //
    // SAVE ONLINE USER
    //
    this.onlineUsers.set(userId, client.id);

    await client.join(userId);

    this.server.emit('userOnline', userId);

    client.emit('onlineUsers', Array.from(this.onlineUsers.keys()));
  }

  isUserOnline(userId: string) {
    return this.onlineUsers.has(userId);
  }
}
