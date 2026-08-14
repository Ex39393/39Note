export type AiProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'xai'
  | 'deepseek'
  | 'mistral'
  | 'qwen'
  | 'cohere'
  | 'custom-openai-compatible';

export type AiProviderProtocol =
  'openai-chat-completions' | 'anthropic-messages' | 'google-gemini' | 'cohere-v2-chat';

export type AiAuthenticationStrategy =
  'bearer' | 'anthropic-api-key' | 'google-api-key';

export type QwenRegion = 'international' | 'us' | 'china' | 'custom';

export interface AiProviderConfig {
  providerId: AiProviderId;
  protocol: AiProviderProtocol;
  providerLabel: string;
  baseUrl: string;
  endpointPath: string;
  model: string;
  temperature: number;
  maximumOutputTokens: number;
  contextCharacterBudget: number;
  customHeaders: Record<string, string>;
  rememberApiKey: boolean;
  qwenRegion: QwenRegion;
  qwenWorkspaceId: string;
}

export interface AiPromptProfile {
  id: string;
  name: string;
  prompt: string;
  builtIn: boolean;
}

export type AiContextScope = 'document' | 'current-page' | 'selected-text';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequestContextPreview {
  scope: AiContextScope;
  pages: number[];
  characters: number;
  excerptCount: number;
}
