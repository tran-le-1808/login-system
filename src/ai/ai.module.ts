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
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],

      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),

        signOptions: {
          expiresIn: '1d',
        },
      }),
    }),
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
