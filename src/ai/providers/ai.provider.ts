// src/ai/providers/ai.provider.ts

export type AIMessageRole = 'system' | 'user' | 'assistant';

export interface AIMessage {
  role: AIMessageRole;
  content: string;
}

export interface AIChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface AIProvider {
  chat(messages: AIMessage[], options?: AIChatOptions): Promise<string>;

  stream(
    messages: AIMessage[],
    onChunk: (chunk: string) => void,
    options?: AIChatOptions,
  ): Promise<void>;
}
