import { MessageType } from 'src/chat/entities/message.entity';

export const AI_BOT_ID = 'AI_ASSISTANT';

export const AI_MESSAGE_TYPE = MessageType.TEXT;

export type AIMessageSender = 'user' | 'assistant';

export interface AIMessageMetadata {
  sender: AIMessageSender;
  model?: string;
  provider?: string;
}
