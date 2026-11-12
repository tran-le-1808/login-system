import { Module } from '@nestjs/common';

import { ChatGateway } from './chat.gateway';

import { ChatController } from './chat.controller';
import { ChatFilesController } from './chat-files.controller';

import { ChatService } from './chat.service';

import { MongooseModule } from '@nestjs/mongoose';
import { Message, MessageSchema } from './entities/message.entity';
import {
  Conversation,
  ConversationSchema,
} from './entities/conversation.entity';
import { User, UserSchema } from 'src/users/entities/user.entity';
import { CloudinaryService } from 'src/common/cloudinary/cloudinary.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Message.name,
        schema: MessageSchema,
      },
      {
        name: Conversation.name,
        schema: ConversationSchema,
      },
      {
        name: User.name,
        schema: UserSchema,
      },
    ]),
  ],

  controllers: [ChatController, ChatFilesController],

  providers: [ChatGateway, ChatService, CloudinaryService],
})
export class ChatModule {}
