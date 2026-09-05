export enum AIProviderType {
  GROQ = 'groq',
  GEMINI = 'gemini',
  OLLAMA = 'ollama',
}

export interface AIConversationMetadata {
  provider: AIProviderType;
  model: string;
  title?: string;
}
