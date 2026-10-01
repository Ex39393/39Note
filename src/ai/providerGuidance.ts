import type { AiProviderId } from './types.ts';

export interface AiProviderKeyGuidance {
  url?: string;
  steps: readonly string[];
}

const GUIDANCE: Record<AiProviderId, AiProviderKeyGuidance> = {
  openai: {
    url: 'https://platform.openai.com/api-keys',
    steps: [
      'Open the OpenAI developer platform.',
      'Create a project API key.',
      'Copy it into 39Note.',
    ],
  },
  anthropic: {
    url: 'https://console.anthropic.com/settings/keys',
    steps: [
      'Open the Anthropic Console.',
      'Create an API key.',
      'Copy it into 39Note.',
    ],
  },
  gemini: {
    url: 'https://aistudio.google.com/app/apikey',
    steps: [
      'Open Google AI Studio.',
      'Create or select an API key.',
      'Copy it into 39Note.',
    ],
  },
  xai: {
    url: 'https://console.x.ai/team/default/api-keys',
    steps: ['Open the xAI Console.', 'Create a team API key.', 'Copy it into 39Note.'],
  },
  deepseek: {
    url: 'https://platform.deepseek.com/api_keys',
    steps: [
      'Open the DeepSeek Platform.',
      'Create an API key.',
      'Copy it into 39Note.',
    ],
  },
  mistral: {
    url: 'https://console.mistral.ai/api-keys',
    steps: ['Open the Mistral Console.', 'Create an API key.', 'Copy it into 39Note.'],
  },
  cohere: {
    url: 'https://dashboard.cohere.com/api-keys',
    steps: [
      'Open the Cohere Dashboard.',
      'Create or copy an API key.',
      'Paste it into 39Note.',
    ],
  },
  qwen: {
    url: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    steps: [
      'Open Alibaba Model Studio key guidance.',
      'Create a DashScope API key for the correct region.',
      'Copy it into 39Note.',
    ],
  },
  'custom-openai-compatible': {
    steps: [
      'Open your provider dashboard.',
      'Create an API credential.',
      'Enter its base URL, model, and key in 39Note.',
    ],
  },
};

export function getProviderKeyGuidance(
  providerId: AiProviderId,
): AiProviderKeyGuidance {
  return GUIDANCE[providerId];
}
