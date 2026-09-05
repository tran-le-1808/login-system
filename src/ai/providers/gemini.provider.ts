// src/ai/providers/gemini.provider.ts

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AIChatOptions, AIMessage, AIProvider } from './ai.provider';

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  parts?: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

@Injectable()
export class GeminiProvider implements AIProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('GEMINI_API_KEY') || '';

    this.model =
      this.configService.get<string>('GEMINI_MODEL') || 'gemini-2.5-flash';
  }

  private convertMessages(messages: AIMessage[]) {
    const systemMessage = messages.find((message) => message.role === 'system');

    const chatMessages = messages.filter(
      (message) => message.role !== 'system',
    );

    return {
      systemInstruction: systemMessage
        ? {
            parts: [
              {
                text: systemMessage.content,
              },
            ],
          }
        : undefined,

      contents: chatMessages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',

        parts: [
          {
            text: message.content,
          },
        ],
      })),
    };
  }

  async chat(messages: AIMessage[], options?: AIChatOptions): Promise<string> {
    if (!this.apiKey) {
      throw new InternalServerErrorException(
        'GEMINI_API_KEY is not configured',
      );
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${this.model}:generateContent?key=${this.apiKey}`;

    const converted = this.convertMessages(messages);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...converted,

        generationConfig: {
          temperature: options?.temperature ?? 0.7,
          maxOutputTokens: options?.maxTokens ?? 2048,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      throw new InternalServerErrorException(`Gemini API error: ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponse;

    return (
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || '')
        .join('') || ''
    );
  }

  isGeminiStreamResponse(value: unknown): value is GeminiResponse {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const obj = value as Record<string, unknown>;

    return obj.candidates === undefined || Array.isArray(obj.candidates);
  }

  async stream(
    messages: AIMessage[],
    onChunk: (chunk: string) => void,
    options?: AIChatOptions,
  ): Promise<void> {
    if (!this.apiKey) {
      throw new InternalServerErrorException(
        'GEMINI_API_KEY is not configured',
      );
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const converted = this.convertMessages(messages);

    const response = await fetch(url, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        ...converted,

        generationConfig: {
          temperature: options?.temperature ?? 0.7,

          maxOutputTokens: options?.maxTokens ?? 2048,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      throw new InternalServerErrorException(`Gemini API error: ${errorText}`);
    }

    if (!response.body) {
      throw new InternalServerErrorException('Gemini response body is empty');
    }

    const reader = response.body.getReader();

    const decoder = new TextDecoder();

    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, {
        stream: true,
      });

      const lines = buffer.split('\n');

      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const jsonData = trimmed.replace(/^data:\s*/, '');

        if (!jsonData) {
          continue;
        }

        try {
          const parsed: unknown = JSON.parse(jsonData);

          if (!this.isGeminiStreamResponse(parsed)) {
            continue;
          }

          const parts = parsed.candidates?.[0]?.content?.parts;

          if (!parts) {
            continue;
          }

          const content = parts.map((part) => part.text ?? '').join('');

          if (content) {
            onChunk(content);
          }
        } catch {
          // Ignore malformed SSE chunks
        }
      }
    }
  }
}
