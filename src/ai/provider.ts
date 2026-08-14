import { getProviderDefinition } from './registry.ts';
import type { AiProviderConfig, AiProviderProtocol, ProviderMessage } from './types';

export interface ChatCompletionRequest {
  config: AiProviderConfig;
  apiKey: string;
  messages: ProviderMessage[];
  signal?: AbortSignal;
  stream?: boolean;
  onDelta?: (delta: string) => void;
}

export interface ChatCompletionResult {
  content: string;
  streamed: boolean;
}

export interface AiProviderAdapter {
  protocol: AiProviderProtocol;
  testConnection: (
    config: AiProviderConfig,
    apiKey: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  complete: (request: ChatCompletionRequest) => Promise<ChatCompletionResult>;
  discoverModels: (
    config: AiProviderConfig,
    apiKey: string,
    signal?: AbortSignal,
  ) => Promise<string[]>;
}

export type AiProviderAdapterRegistry = Record<AiProviderProtocol, AiProviderAdapter>;

type FetchFunction = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface StreamDelta {
  delta?: string;
  done?: boolean;
}

export function createProviderAdapterRegistry(
  fetchImpl: FetchFunction = (input, init) => fetch(input, init),
): AiProviderAdapterRegistry {
  const createAdapter = (
    protocol: AiProviderProtocol,
    buildBody: (request: ChatCompletionRequest) => Record<string, unknown>,
    parseResponse: (value: unknown) => string,
    parseEvent: (value: unknown, eventName: string) => StreamDelta,
  ): AiProviderAdapter => {
    const complete = (request: ChatCompletionRequest) =>
      completeRequest(
        fetchImpl,
        protocol,
        request,
        buildBody,
        parseResponse,
        parseEvent,
      );
    return {
      protocol,
      complete,
      async testConnection(config, apiKey, signal) {
        await complete({
          config,
          apiKey,
          signal,
          stream: false,
          messages: [
            { role: 'system', content: 'Reply with only the word connected.' },
            { role: 'user', content: 'Connection test.' },
          ],
        });
      },
      discoverModels: (config, apiKey, signal) =>
        discoverProviderModels(fetchImpl, config, apiKey, signal),
    };
  };

  return {
    'openai-chat-completions': createAdapter(
      'openai-chat-completions',
      buildOpenAiBody,
      parseOpenAiResponse,
      parseOpenAiEvent,
    ),
    'anthropic-messages': createAdapter(
      'anthropic-messages',
      buildAnthropicBody,
      parseAnthropicResponse,
      parseAnthropicEvent,
    ),
    'google-gemini': createAdapter(
      'google-gemini',
      buildGeminiBody,
      parseGeminiResponse,
      parseGeminiEvent,
    ),
    'cohere-v2-chat': createAdapter(
      'cohere-v2-chat',
      buildCohereBody,
      parseCohereResponse,
      parseCohereEvent,
    ),
  };
}

export const adapterRegistry = createProviderAdapterRegistry();

// Retained as a compatibility export for callers and tests built against v1.
export const openAiCompatibleAdapter = adapterRegistry['openai-chat-completions'];

export function resolveProviderAdapter(config: AiProviderConfig): AiProviderAdapter {
  return adapterRegistry[config.protocol];
}

async function completeRequest(
  fetchImpl: FetchFunction,
  protocol: AiProviderProtocol,
  request: ChatCompletionRequest,
  buildBody: (request: ChatCompletionRequest) => Record<string, unknown>,
  parseResponse: (value: unknown) => string,
  parseEvent: (value: unknown, eventName: string) => StreamDelta,
): Promise<ChatCompletionResult> {
  if (!request.apiKey.trim()) throw new Error('Enter an API key.');
  if (!request.config.model.trim()) throw new Error('Enter a model name.');
  const endpointPath = getCompletionEndpointPath(
    request.config,
    request.stream === true,
  );
  const endpoint = resolveEndpoint(request.config, endpointPath);
  const timeoutController = new AbortController();
  const timeout = globalThis.setTimeout(
    () => timeoutController.abort('timeout'),
    60_000,
  );
  const combinedSignal = combineSignals(request.signal, timeoutController.signal);
  const headers = createHeaders(
    request.config,
    request.apiKey,
    request.stream === true,
  );

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      signal: combinedSignal,
      body: JSON.stringify(buildBody(request)),
    });
    if (!response.ok) {
      throw await createResponseError(
        response,
        request.apiKey,
        request.config.providerId === 'anthropic',
      );
    }
    return request.stream
      ? readStreamingResponse(response, parseEvent, request.onDelta)
      : readJsonResponse(response, parseResponse);
  } catch (error) {
    if (combinedSignal.aborted) {
      if (timeoutController.signal.aborted && !request.signal?.aborted) {
        throw new Error('Timeout. Check the endpoint and try again.');
      }
      throw new DOMException('Generation cancelled.', 'AbortError');
    }
    if (error instanceof TypeError) {
      const pageProtocol = globalThis.location?.protocol;
      const mixedContent = pageProtocol === 'https:' && endpoint.protocol === 'http:';
      if (mixedContent) {
        throw new Error(
          'Browser/CORS blocked. This HTTPS page cannot call an insecure HTTP endpoint.',
        );
      }
      if (protocol === 'anthropic-messages') {
        throw new Error(
          'Browser/CORS blocked. Anthropic may restrict direct browser access for this API organization. 39Note cannot bypass this restriction; use a browser-enabled organization or an endpoint you control.',
        );
      }
      throw new Error(
        'Browser/CORS blocked. The endpoint may be offline, unavailable, or refusing direct browser requests.',
      );
    }
    throw error instanceof Error ? error : new Error('The provider request failed.');
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function getCompletionEndpointPath(config: AiProviderConfig, stream: boolean): string {
  const definition = getProviderDefinition(config.providerId);
  if (!stream || !definition.streamEndpoint) return config.endpointPath;
  if (config.endpointPath === definition.defaultEndpoint) {
    return definition.streamEndpoint;
  }
  if (config.protocol === 'google-gemini') {
    const streamingPath = config.endpointPath.replace(
      /:generateContent(?=\?|$)/,
      ':streamGenerateContent',
    );
    if (streamingPath.includes('alt=sse')) return streamingPath;
    return `${streamingPath}${streamingPath.includes('?') ? '&' : '?'}alt=sse`;
  }
  return config.endpointPath;
}

function buildOpenAiBody(request: ChatCompletionRequest): Record<string, unknown> {
  return {
    model: request.config.model,
    messages: request.messages,
    ...(getProviderDefinition(request.config.providerId).supportsTemperature
      ? { temperature: request.config.temperature }
      : {}),
    max_tokens: request.config.maximumOutputTokens,
    stream: request.stream === true,
  };
}

function buildAnthropicBody(request: ChatCompletionRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  return {
    model: request.config.model,
    messages: request.messages
      .filter((message) => message.role !== 'system')
      .map(({ role, content }) => ({ role, content })),
    ...(system ? { system } : {}),
    temperature: request.config.temperature,
    max_tokens: request.config.maximumOutputTokens,
    stream: request.stream === true,
  };
}

function buildGeminiBody(request: ChatCompletionRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
    generationConfig: {
      temperature: request.config.temperature,
      maxOutputTokens: request.config.maximumOutputTokens,
    },
  };
}

function buildCohereBody(request: ChatCompletionRequest): Record<string, unknown> {
  return {
    model: request.config.model,
    messages: request.messages,
    temperature: request.config.temperature,
    max_tokens: request.config.maximumOutputTokens,
    stream: request.stream === true,
  };
}

function createHeaders(
  config: AiProviderConfig,
  apiKey: string,
  stream: boolean,
): Headers {
  const definition = getProviderDefinition(config.providerId);
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  });
  if (definition.authenticationStrategy === 'bearer') {
    headers.set('Authorization', `Bearer ${apiKey}`);
  } else if (definition.authenticationStrategy === 'anthropic-api-key') {
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('x-goog-api-key', apiKey);
  }
  for (const [name, value] of Object.entries(config.customHeaders)) {
    if (
      !/^(authorization|cookie|host|content-length|x-api-key|x-goog-api-key)$/i.test(
        name,
      )
    ) {
      headers.set(name, value);
    }
  }
  return headers;
}

function resolveEndpoint(config: AiProviderConfig, endpointPath: string): URL {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error('The Base URL is invalid.');
  }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) {
    throw new Error('Use an HTTP(S) Base URL without credentials in the URL.');
  }
  const resolvedPath = endpointPath.replace(
    /\{model\}/g,
    encodeURIComponent(config.model.trim()),
  );
  try {
    return new URL(
      `${base.href.replace(/\/+$/, '')}/${resolvedPath.replace(/^\/+/, '')}`,
    );
  } catch {
    throw new Error('The API endpoint path is invalid.');
  }
}

async function readJsonResponse(
  response: Response,
  parseResponse: (value: unknown) => string,
): Promise<ChatCompletionResult> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('Malformed provider response: invalid JSON.');
  }
  return { content: parseResponse(value), streamed: false };
}

async function readStreamingResponse(
  response: Response,
  parseEvent: (value: unknown, eventName: string) => StreamDelta,
  onDelta?: (delta: string) => void,
): Promise<ChatCompletionResult> {
  if (!response.body) throw new Error('Malformed provider response: no stream body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let receivedText = false;
  let ended = false;

  const consumeEvent = (block: string) => {
    const lines = block.split(/\r?\n/);
    const eventName =
      lines
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim() ?? '';
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    if (data === '[DONE]') {
      ended = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error('Malformed provider response: invalid streaming event.');
    }
    const event = parseEvent(value, eventName);
    if (event.delta !== undefined && event.delta !== '') {
      receivedText = true;
      content += event.delta;
      onDelta?.(event.delta);
    }
    if (event.done) ended = true;
  };

  while (!ended) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = done ? '' : (blocks.pop() ?? '');
    for (const block of blocks) {
      if (ended) break;
      consumeEvent(block);
    }
    if (done) {
      if (buffer.trim()) consumeEvent(buffer);
      break;
    }
  }
  if (!receivedText) {
    throw new Error(
      'Malformed provider response: stream ended without assistant text.',
    );
  }
  return { content, streamed: true };
}

function parseOpenAiResponse(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new Error('Malformed provider response: missing assistant choices.');
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error('Malformed provider response: missing assistant message.');
  }
  return readTextValue(choice.message.content);
}

function parseOpenAiEvent(value: unknown): StreamDelta {
  if (!isRecord(value) || !Array.isArray(value.choices)) return {};
  const choice = value.choices[0];
  if (!isRecord(choice)) return {};
  const done = choice.finish_reason !== null && choice.finish_reason !== undefined;
  if (!isRecord(choice.delta)) return done ? { done: true } : {};
  const delta = readOptionalTextValue(choice.delta.content);
  return {
    ...(delta === null ? {} : { delta }),
    ...(done ? { done: true } : {}),
  };
}

function parseAnthropicResponse(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error('Malformed provider response: missing Claude content blocks.');
  }
  const content = value.content
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
  if (!content) {
    throw new Error('Malformed provider response: no assistant text.');
  }
  return content;
}

function parseAnthropicEvent(value: unknown, eventName: string): StreamDelta {
  if (!isRecord(value)) return {};
  const type = typeof value.type === 'string' ? value.type : eventName;
  if (type === 'message_stop') return { done: true };
  if (type === 'error') {
    throw new Error('Provider unavailable during streaming.');
  }
  if (type !== 'content_block_delta' || !isRecord(value.delta)) return {};
  return value.delta.type === 'text_delta' && typeof value.delta.text === 'string'
    ? { delta: value.delta.text }
    : {};
}

function parseGeminiResponse(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error('Malformed provider response: invalid Gemini response.');
  }
  const blockReason = isRecord(value.promptFeedback)
    ? value.promptFeedback.blockReason
    : undefined;
  const text = extractGeminiText(value);
  if (text) return text;
  if (typeof blockReason === 'string' || hasGeminiSafetyFinish(value)) {
    throw new Error('The provider blocked this response under its safety policy.');
  }
  throw new Error('Malformed provider response: no Gemini candidate text.');
}

function parseGeminiEvent(value: unknown): StreamDelta {
  if (!isRecord(value)) return {};
  const text = extractGeminiText(value);
  const done = hasGeminiFinalFinish(value);
  if (!text && hasGeminiSafetyFinish(value)) {
    throw new Error('The provider blocked this response under its safety policy.');
  }
  return { ...(text ? { delta: text } : {}), ...(done ? { done: true } : {}) };
}

function extractGeminiText(value: Record<string, unknown>): string {
  if (!Array.isArray(value.candidates)) return '';
  const candidate = value.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content)) return '';
  const parts = candidate.content.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => isRecord(part) && typeof part.text === 'string')
    .map((part) => (part as Record<string, unknown>).text as string)
    .join('');
}

function hasGeminiSafetyFinish(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.candidates)) return false;
  const candidate = value.candidates[0];
  if (!isRecord(candidate) || typeof candidate.finishReason !== 'string') return false;
  return ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(
    candidate.finishReason,
  );
}

function hasGeminiFinalFinish(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.candidates)) return false;
  const candidate = value.candidates[0];
  return isRecord(candidate) && typeof candidate.finishReason === 'string';
}

function parseCohereResponse(value: unknown): string {
  if (
    !isRecord(value) ||
    !isRecord(value.message) ||
    !Array.isArray(value.message.content)
  ) {
    throw new Error('Malformed provider response: missing Cohere content blocks.');
  }
  const content = value.message.content
    .filter((block) => isRecord(block) && typeof block.text === 'string')
    .map((block) => (block as Record<string, unknown>).text as string)
    .join('');
  if (!content) throw new Error('Malformed provider response: no assistant text.');
  return content;
}

function parseCohereEvent(value: unknown, eventName: string): StreamDelta {
  if (!isRecord(value)) return {};
  const type = typeof value.type === 'string' ? value.type : eventName;
  if (type === 'message-end') return { done: true };
  if (type !== 'content-delta' || !isRecord(value.delta)) return {};
  const message = value.delta.message;
  if (!isRecord(message) || !isRecord(message.content)) return {};
  return typeof message.content.text === 'string'
    ? { delta: message.content.text }
    : {};
}

async function discoverProviderModels(
  fetchImpl: FetchFunction,
  config: AiProviderConfig,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const definition = getProviderDefinition(config.providerId);
  if (!definition.supportsModelDiscovery || !definition.modelDiscoveryEndpoint) {
    throw new Error('This provider does not expose a stable model list in 39Note.');
  }
  if (!apiKey.trim()) throw new Error('Enter an API key before loading models.');
  const endpoint = resolveEndpoint(config, definition.modelDiscoveryEndpoint);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: createHeaders(config, apiKey, false),
      signal,
    });
    if (!response.ok) {
      throw await createResponseError(
        response,
        apiKey,
        config.providerId === 'anthropic',
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error('Malformed provider response: invalid model-list JSON.');
    }
    return parseModelList(config.protocol, value);
  } catch (error) {
    if (signal?.aborted)
      throw new DOMException('Model loading cancelled.', 'AbortError');
    if (error instanceof TypeError) {
      throw new Error(
        'Browser/CORS blocked the model-list request. Enter a model manually.',
      );
    }
    throw error;
  }
}

function parseModelList(protocol: AiProviderProtocol, value: unknown): string[] {
  if (!isRecord(value))
    throw new Error('Malformed provider response: invalid model list.');
  let models: string[] = [];
  if (protocol === 'google-gemini' && Array.isArray(value.models)) {
    models = value.models.flatMap((model) => {
      if (!isRecord(model) || typeof model.name !== 'string') return [];
      if (
        Array.isArray(model.supportedGenerationMethods) &&
        !model.supportedGenerationMethods.includes('generateContent')
      ) {
        return [];
      }
      return [model.name.replace(/^models\//, '')];
    });
  } else {
    const entries = Array.isArray(value.data)
      ? value.data
      : Array.isArray(value.models)
        ? value.models
        : [];
    models = entries.flatMap((model) => {
      if (!isRecord(model)) return [];
      const name =
        typeof model.id === 'string'
          ? model.id
          : typeof model.name === 'string'
            ? model.name
            : '';
      return name ? [name] : [];
    });
  }
  const unique = [...new Set(models)].sort((first, second) =>
    first.localeCompare(second),
  );
  if (!unique.length) {
    throw new Error('The provider returned no discoverable text-generation models.');
  }
  return unique;
}

async function createResponseError(
  response: Response,
  apiKey: string,
  isAnthropic: boolean,
): Promise<Error> {
  let providerMessage = '';
  try {
    const value = (await response.json()) as unknown;
    if (isRecord(value)) {
      const candidate = isRecord(value.error) ? value.error.message : value.message;
      if (typeof candidate === 'string') {
        providerMessage = sanitizeErrorMessage(candidate, apiKey);
      }
    }
  } catch {
    // Status-based messages are safer than echoing an arbitrary response body.
  }
  if (isAnthropic && /CORS requests are not allowed/i.test(providerMessage)) {
    return new Error(
      'Browser/CORS blocked. Anthropic rejected direct browser access for this API organization. 39Note cannot bypass this restriction. Use a browser-enabled organization or an endpoint you control.',
    );
  }
  const statusMessage =
    response.status === 401 || response.status === 403
      ? 'Authentication failed. Check the API key and authorization settings.'
      : response.status === 404
        ? 'Model not found. Check the model and endpoint.'
        : response.status === 408
          ? 'Timeout. The provider did not complete the request.'
          : response.status === 413
            ? 'Request too large for this provider.'
            : response.status === 429
              ? 'Rate limit reached. Wait and try again.'
              : response.status >= 500
                ? 'Provider unavailable. Try again later.'
                : `The provider rejected the request (HTTP ${response.status}).`;
  return new Error(
    providerMessage ? `${statusMessage} ${providerMessage}` : statusMessage,
  );
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  let result = message
    .replace(/authorization\s*:\s*\S+/gi, 'authorization: [redacted]')
    .replace(/(?:x-api-key|x-goog-api-key)\s*:\s*\S+/gi, '[api-key redacted]');
  if (apiKey) result = result.split(apiKey).join('[redacted]');
  return result.slice(0, 500);
}

function readTextValue(value: unknown): string {
  const text = readOptionalTextValue(value);
  if (text === null || !text) {
    throw new Error('Malformed provider response: no assistant text.');
  }
  return text;
}

function readOptionalTextValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  return value
    .filter((part) => isRecord(part) && typeof part.text === 'string')
    .map((part) => (part as Record<string, unknown>).text as string)
    .join('');
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal {
  const signals = [first, second].filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
