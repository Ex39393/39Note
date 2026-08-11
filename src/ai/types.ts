export interface AiProviderConfig {
  providerLabel: string;
  baseUrl: string;
  endpointPath: string;
  model: string;
  temperature: number;
  maximumOutputTokens: number;
  contextCharacterBudget: number;
  customHeaders: Record<string, string>;
  rememberApiKey: boolean;
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
