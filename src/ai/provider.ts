import type { AiProviderConfig, ProviderMessage } from './types';

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
  protocol: 'openai-compatible-chat-completions';
  testConnection: (
    config: AiProviderConfig,
    apiKey: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  complete: (request: ChatCompletionRequest) => Promise<ChatCompletionResult>;
}

export const openAiCompatibleAdapter: AiProviderAdapter = {
  protocol: 'openai-compatible-chat-completions',
  async testConnection(config, apiKey, signal) {
    await completeChat({
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
  complete: completeChat,
};

async function completeChat(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const endpoint = resolveEndpoint(request.config);
  const timeoutController = new AbortController();
  const timeout = window.setTimeout(() => timeoutController.abort('timeout'), 60_000);
  const combinedSignal = combineSignals(request.signal, timeoutController.signal);
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: request.stream ? 'text/event-stream' : 'application/json',
  });
  if (request.apiKey) headers.set('Authorization', `Bearer ${request.apiKey}`);
  for (const [name, value] of Object.entries(request.config.customHeaders)) {
    if (!/^(authorization|cookie|host|content-length)$/i.test(name)) {
      headers.set(name, value);
    }
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: combinedSignal,
      body: JSON.stringify({
        model: request.config.model,
        messages: request.messages,
        temperature: request.config.temperature,
        max_tokens: request.config.maximumOutputTokens,
        stream: request.stream === true,
      }),
    });
    if (!response.ok) throw await createResponseError(response, request.apiKey);
    return request.stream
      ? readStreamingResponse(response, request.onDelta)
      : readJsonResponse(response);
  } catch (error) {
    if (combinedSignal.aborted) {
      if (timeoutController.signal.aborted && !request.signal?.aborted) {
        throw new Error(
          'The provider request timed out. Check the endpoint and try again.',
        );
      }
      throw new DOMException('Generation stopped.', 'AbortError');
    }
    if (error instanceof TypeError) {
      const mixedContent =
        window.location.protocol === 'https:' && endpoint.protocol === 'http:';
      throw new Error(
        mixedContent
          ? 'The browser blocked an insecure HTTP endpoint from this HTTPS page. Use HTTPS.'
          : 'The browser could not reach this endpoint. It may be offline, unavailable, or blocking browser requests with CORS.',
      );
    }
    throw error instanceof Error ? error : new Error('The provider request failed.');
  } finally {
    window.clearTimeout(timeout);
  }
}

function resolveEndpoint(config: AiProviderConfig): URL {
  if (!config.model.trim()) throw new Error('Enter a model name.');
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error('The Base URL is invalid.');
  }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) {
    throw new Error('Use an HTTP(S) Base URL without credentials in the URL.');
  }
  try {
    return new URL(
      config.endpointPath || '/v1/chat/completions',
      `${base.href.replace(/\/$/, '')}/`,
    );
  } catch {
    throw new Error('The API endpoint path is invalid.');
  }
}

async function readJsonResponse(response: Response): Promise<ChatCompletionResult> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('The provider returned malformed JSON.');
  }
  const content = getCompletionContent(value);
  if (content === null)
    throw new Error('The provider response did not contain assistant text.');
  return { content, streamed: false };
}

async function readStreamingResponse(
  response: Response,
  onDelta?: (delta: string) => void,
): Promise<ChatCompletionResult> {
  if (!response.body) throw new Error('The provider did not return a streaming body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let receivedEvent = false;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error('The provider returned malformed streaming data.');
      }
      const delta = getDeltaContent(event);
      if (delta !== null) {
        receivedEvent = true;
        content += delta;
        onDelta?.(delta);
      }
    }
    if (done) break;
  }
  if (!receivedEvent && !content) {
    throw new Error('The provider stream ended without assistant text.');
  }
  return { content, streamed: true };
}

function getCompletionContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  return typeof choice.message.content === 'string' ? choice.message.content : null;
}

function getDeltaContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) return null;
  return typeof choice.delta.content === 'string' ? choice.delta.content : null;
}

async function createResponseError(response: Response, apiKey: string): Promise<Error> {
  let providerMessage = '';
  try {
    const value = (await response.json()) as unknown;
    if (
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.message === 'string'
    ) {
      providerMessage = sanitizeErrorMessage(value.error.message, apiKey);
    }
  } catch {
    // Status-based messages below are safer than echoing an arbitrary response body.
  }
  const statusMessage =
    response.status === 401 || response.status === 403
      ? 'The provider rejected the API key or authorization settings.'
      : response.status === 404
        ? 'The endpoint or model was not found.'
        : response.status === 408
          ? 'The provider request timed out.'
          : response.status === 413
            ? 'The request is too large for this provider.'
            : response.status === 429
              ? 'The provider rate limit was reached. Wait and try again.'
              : response.status >= 500
                ? 'The provider is temporarily unavailable.'
                : `The provider rejected the request (HTTP ${response.status}).`;
  return new Error(
    providerMessage ? `${statusMessage} ${providerMessage}` : statusMessage,
  );
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  let result = message.replace(
    /authorization\s*:\s*\S+/gi,
    'authorization: [redacted]',
  );
  if (apiKey) result = result.split(apiKey).join('[redacted]');
  return result.slice(0, 500);
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
