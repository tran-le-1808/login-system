// src/ai/ai.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AIController } from './ai.controller';
import { AIGateway } from './ai.gateway';
import { AIService } from './ai.service';

import { GeminiProvider } from './providers/gemini.provider';

import { AIProvider } from './providers/ai.provider';
import {
  Conversation,
  ConversationSchema,
} from 'src/chat/entities/conversation.entity';
import { Message, MessageSchema } from 'src/chat/entities/message.entity';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Conversation.name,
        schema: ConversationSchema,
      },
      {
        name: Message.name,
        schema: MessageSchema,
      },
    ]),
  ],

  controllers: [AIController],

  providers: [
    AIGateway,
    AIService,

    GeminiProvider,

    {
      provide: 'AI_PROVIDER',
      inject: [GeminiProvider],

      useFactory: (geminiProvider: GeminiProvider): AIProvider => {
        return geminiProvider;
      },
    },
  ],

  exports: [AIService],
})
export class AIModule {}
