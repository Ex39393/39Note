import type {
  AiAuthenticationStrategy,
  AiProviderConfig,
  AiProviderId,
  AiProviderProtocol,
  QwenRegion,
} from './types';

export interface ProviderDefinition {
  id: AiProviderId;
  displayName: string;
  protocol: AiProviderProtocol;
  defaultBaseUrl: string;
  defaultEndpoint: string;
  streamEndpoint?: string;
  authenticationStrategy: AiAuthenticationStrategy;
  supportsStreaming: boolean;
  supportsTemperature: boolean;
  supportsModelDiscovery: boolean;
  modelDiscoveryEndpoint?: string;
  documentationHint: string;
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.openai.com',
    defaultEndpoint: '/v1/chat/completions',
    authenticationStrategy: 'bearer',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: true,
    modelDiscoveryEndpoint: '/v1/models',
    documentationHint: 'Create an API key in the OpenAI developer platform.',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic / Claude',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultEndpoint: '/v1/messages',
    authenticationStrategy: 'anthropic-api-key',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: true,
    modelDiscoveryEndpoint: '/v1/models',
    documentationHint:
      'Use a Claude API key. Some organizations may restrict direct browser requests.',
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    protocol: 'google-gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultEndpoint: '/v1beta/models/{model}:generateContent',
    streamEndpoint: '/v1beta/models/{model}:streamGenerateContent?alt=sse',
    authenticationStrategy: 'google-api-key',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: true,
    modelDiscoveryEndpoint: '/v1beta/models',
    documentationHint: 'Use a Gemini API key from Google AI services.',
  },
  {
    id: 'xai',
    displayName: 'xAI / Grok',
    protocol: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.x.ai',
    defaultEndpoint: '/v1/chat/completions',
    authenticationStrategy: 'bearer',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: true,
    modelDiscoveryEndpoint: '/v1/models',
    documentationHint:
      'Use an xAI API key and enter a model available to your account.',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultEndpoint: '/chat/completions',
    authenticationStrategy: 'bearer',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: true,
    modelDiscoveryEndpoint: '/models',
    documentationHint: 'Use a DeepSeek API key and enter a current model name.',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    protocol: 'openai-chat-completions',
    defaultBaseUrl: 'https://api.mistral.ai',
    defaultEndpoint: '/v1/chat/completions',
    authenticationStrategy: 'bearer',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: true,
    modelDiscoveryEndpoint: '/v1/models',
    documentationHint:
      'Use a Mistral API key and enter a model available to your account.',
  },
  {
    id: 'qwen',
    displayName: 'Alibaba Qwen',
    protocol: 'openai-chat-completions',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultEndpoint: '/chat/completions',
    authenticationStrategy: 'bearer',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: false,
    documentationHint: 'Choose the region and workspace matching your API key.',
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    protocol: 'cohere-v2-chat',
    defaultBaseUrl: 'https://api.cohere.com',
    defaultEndpoint: '/v2/chat',
    authenticationStrategy: 'bearer',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: true,
    modelDiscoveryEndpoint: '/v1/models',
    documentationHint: 'Use a Cohere production or trial API key.',
  },
  {
    id: 'custom-openai-compatible',
    displayName: 'Custom OpenAI-compatible',
    protocol: 'openai-chat-completions',
    defaultBaseUrl: '',
    defaultEndpoint: '/v1/chat/completions',
    authenticationStrategy: 'bearer',
    supportsStreaming: true,
    supportsTemperature: true,
    supportsModelDiscovery: false,
    documentationHint:
      'Use a browser-compatible endpoint you control. 39Note never adds a CORS proxy.',
  },
];

export const providerRegistry = Object.fromEntries(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<AiProviderId, ProviderDefinition>;

export function getProviderDefinition(providerId: AiProviderId): ProviderDefinition {
  return providerRegistry[providerId] ?? providerRegistry['custom-openai-compatible'];
}

export function createProviderPreset(
  providerId: AiProviderId,
  current: AiProviderConfig,
): AiProviderConfig {
  const definition = getProviderDefinition(providerId);
  return {
    ...current,
    providerId,
    protocol: definition.protocol,
    providerLabel: definition.displayName,
    baseUrl: definition.defaultBaseUrl,
    endpointPath: definition.defaultEndpoint,
    model: '',
    customHeaders: {},
    rememberApiKey: false,
    qwenRegion: 'international',
    qwenWorkspaceId: '',
  };
}

export function inferProviderId(baseUrl: string): AiProviderId {
  const normalized = normalizeBaseUrl(baseUrl);
  const match = PROVIDER_DEFINITIONS.find(
    (definition) =>
      definition.id !== 'custom-openai-compatible' &&
      normalizeBaseUrl(definition.defaultBaseUrl) === normalized,
  );
  if (match) return match.id;
  const qwenRegion = Object.values(QWEN_SHARED_BASE_URLS).find(
    (candidate) => normalizeBaseUrl(candidate) === normalized,
  );
  return qwenRegion ? 'qwen' : 'custom-openai-compatible';
}

export const QWEN_SHARED_BASE_URLS: Record<Exclude<QwenRegion, 'custom'>, string> = {
  international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  us: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  china: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

export function resolveQwenBaseUrl(
  region: QwenRegion,
  workspaceId: string,
  currentCustomBaseUrl = '',
): string {
  if (region === 'custom') return currentCustomBaseUrl;
  const cleanWorkspaceId = workspaceId.trim();
  if (!cleanWorkspaceId) return QWEN_SHARED_BASE_URLS[region];
  if (!/^[A-Za-z0-9-]{1,128}$/.test(cleanWorkspaceId)) {
    return QWEN_SHARED_BASE_URLS[region];
  }
  if (region === 'international') {
    return `https://${cleanWorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`;
  }
  if (region === 'china') {
    return `https://${cleanWorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;
  }
  // Alibaba currently documents a shared US domain but not a US workspace domain.
  return QWEN_SHARED_BASE_URLS.us;
}

export function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}
