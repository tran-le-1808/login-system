// src/ai/dto/create-conversation.dto.ts

import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { AIProviderType } from '../schemas/ai-conversation.schema';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsEnum(AIProviderType)
  provider?: AIProviderType;

  @IsOptional()
  @IsString()
  model?: string;
}
