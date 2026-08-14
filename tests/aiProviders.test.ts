import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_AI_CONFIG,
  clearAiConfiguration,
  getCredentialProfileId,
  loadAiConfiguration,
  loadApiKey,
  saveAiConfiguration,
} from '../src/ai/configuration.ts';
import {
  createProviderAdapterRegistry,
  resolveProviderAdapter,
  type ChatCompletionRequest,
} from '../src/ai/provider.ts';
import {
  PROVIDER_DEFINITIONS,
  createProviderPreset,
  resolveQwenBaseUrl,
} from '../src/ai/registry.ts';
import type { AiProviderConfig, AiProviderId } from '../src/ai/types.ts';

const normalFixtures = {
  'openai-chat-completions': { choices: [{ message: { content: 'Hello world' } }] },
  'anthropic-messages': {
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ],
  },
  'google-gemini': {
    candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world' }] } }],
  },
  'cohere-v2-chat': {
    message: { content: [{ type: 'text', text: 'Hello world' }] },
  },
} as const;

const streamFixtures = {
  'openai-chat-completions': {
    first:
      'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n',
    second:
      'data: {"choices":[{"delta":{"content":"world"},"finish_reason":null}]}\n\n',
    end: 'data: [DONE]\n\n',
  },
  'anthropic-messages': {
    first:
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
    second:
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
    end: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  },
  'google-gemini': {
    first: 'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\n',
    second: 'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}\n\n',
    end: 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
  },
  'cohere-v2-chat': {
    first:
      'event: content-delta\ndata: {"type":"content-delta","delta":{"message":{"content":{"text":"Hello "}}}}\n\n',
    second:
      'event: content-delta\ndata: {"type":"content-delta","delta":{"message":{"content":{"text":"world"}}}}\n\n',
    end: 'event: message-end\ndata: {"type":"message-end"}\n\n',
  },
} as const;

const protocolProviders: AiProviderId[] = ['openai', 'anthropic', 'gemini', 'cohere'];
const TEST_API_KEY = 'unit-test-placeholder';

test('all first-class presets resolve to the documented protocol adapter', () => {
  const expected = {
    openai: [
      'openai-chat-completions',
      'https://api.openai.com',
      '/v1/chat/completions',
    ],
    anthropic: ['anthropic-messages', 'https://api.anthropic.com', '/v1/messages'],
    gemini: [
      'google-gemini',
      'https://generativelanguage.googleapis.com',
      '/v1beta/models/{model}:generateContent',
    ],
    xai: ['openai-chat-completions', 'https://api.x.ai', '/v1/chat/completions'],
    deepseek: [
      'openai-chat-completions',
      'https://api.deepseek.com',
      '/chat/completions',
    ],
    mistral: [
      'openai-chat-completions',
      'https://api.mistral.ai',
      '/v1/chat/completions',
    ],
    qwen: [
      'openai-chat-completions',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      '/chat/completions',
    ],
    cohere: ['cohere-v2-chat', 'https://api.cohere.com', '/v2/chat'],
    'custom-openai-compatible': ['openai-chat-completions', '', '/v1/chat/completions'],
  } as const;

  for (const definition of PROVIDER_DEFINITIONS) {
    const config = createProviderPreset(definition.id, DEFAULT_AI_CONFIG);
    assert.deepEqual(
      [config.protocol, config.baseUrl, config.endpointPath],
      expected[definition.id],
    );
    assert.equal(resolveProviderAdapter(config).protocol, expected[definition.id][0]);
  }
});

test('Qwen regional and documented workspace URLs are derived safely', () => {
  assert.equal(
    resolveQwenBaseUrl('international', ''),
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    resolveQwenBaseUrl('us', 'workspace-us'),
    'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    resolveQwenBaseUrl('china', 'workspace-39'),
    'https://workspace-39.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    resolveQwenBaseUrl('international', 'workspace-39'),
    'https://workspace-39.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    resolveQwenBaseUrl('international', 'bad.workspace'),
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  );
});

test('protocol adapters translate normal requests, auth, and responses', async (context) => {
  for (const providerId of protocolProviders) {
    await context.test(providerId, async () => {
      const config = configFor(providerId);
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      const adapters = createProviderAdapterRegistry(async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return jsonResponse(normalFixtures[config.protocol]);
      });
      const result = await adapters[config.protocol].complete(requestFor(config));
      assert.equal(result.content, 'Hello world');
      assert.equal(result.streamed, false);
      const headers = new Headers(capturedInit?.headers);
      const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;

      if (providerId === 'openai' || providerId === 'cohere') {
        assert.equal(headers.get('Authorization'), `Bearer ${TEST_API_KEY}`);
      }
      if (providerId === 'anthropic') {
        assert.equal(headers.get('x-api-key'), TEST_API_KEY);
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        assert.equal(headers.has('Authorization'), false);
        assert.equal(body.system, 'System instruction');
        assert.deepEqual(body.messages, [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: 'Prior answer' },
        ]);
      }
      if (providerId === 'gemini') {
        assert.equal(headers.get('x-goog-api-key'), TEST_API_KEY);
        assert.equal(headers.has('Authorization'), false);
        assert.match(capturedUrl, /models\/fixture-model:generateContent$/);
        assert.deepEqual(body.systemInstruction, {
          parts: [{ text: 'System instruction' }],
        });
        assert.deepEqual(body.contents, [
          { role: 'user', parts: [{ text: 'Question' }] },
          { role: 'model', parts: [{ text: 'Prior answer' }] },
        ]);
      }
    });
  }
});

test('Qwen endpoint keeps the OpenAI-compatible base path', async () => {
  const config = configFor('qwen');
  let capturedUrl = '';
  const adapters = createProviderAdapterRegistry(async (input) => {
    capturedUrl = String(input);
    return jsonResponse(normalFixtures['openai-chat-completions']);
  });
  await adapters[config.protocol].complete(requestFor(config));
  assert.equal(
    capturedUrl,
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
});

test('each protocol emits first and subsequent deltas and terminates cleanly', async (context) => {
  for (const providerId of protocolProviders) {
    await context.test(providerId, async () => {
      const config = configFor(providerId);
      const fixture = streamFixtures[config.protocol];
      const adapters = createProviderAdapterRegistry(async () =>
        streamResponse(fixture.first + fixture.second + fixture.end),
      );
      const deltas: string[] = [];
      const result = await adapters[config.protocol].complete({
        ...requestFor(config),
        stream: true,
        onDelta: (delta) => deltas.push(delta),
      });
      assert.deepEqual(deltas, ['Hello ', 'world']);
      assert.deepEqual(result, { content: 'Hello world', streamed: true });
    });
  }
});

test('each protocol rejects malformed and empty streams without exposing framing', async (context) => {
  for (const providerId of protocolProviders) {
    await context.test(`${providerId} malformed`, async () => {
      const config = configFor(providerId);
      const adapters = createProviderAdapterRegistry(async () =>
        streamResponse('data: {not-json}\n\n'),
      );
      await assert.rejects(
        adapters[config.protocol].complete({ ...requestFor(config), stream: true }),
        /Malformed provider response: invalid streaming event/,
      );
    });
    await context.test(`${providerId} empty`, async () => {
      const config = configFor(providerId);
      const adapters = createProviderAdapterRegistry(async () =>
        streamResponse(streamFixtures[config.protocol].end),
      );
      await assert.rejects(
        adapters[config.protocol].complete({ ...requestFor(config), stream: true }),
        /stream ended without assistant text/,
      );
    });
  }
});

test('stream cancellation uses the common AbortController path for every protocol', async (context) => {
  for (const providerId of protocolProviders) {
    await context.test(providerId, async () => {
      const config = configFor(providerId);
      const controller = new AbortController();
      const adapters = createProviderAdapterRegistry(async (_input, init) => {
        const signal = init?.signal;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                encoder.encode(streamFixtures[config.protocol].first),
              );
              signal?.addEventListener('abort', () => {
                streamController.error(new DOMException('Aborted', 'AbortError'));
              });
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      });
      const completion = adapters[config.protocol].complete({
        ...requestFor(config),
        signal: controller.signal,
        stream: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      await assert.rejects(
        completion,
        (error: unknown) =>
          error instanceof DOMException && error.name === 'AbortError',
      );
    });
  }
});

test('authentication, rate-limit, and malformed JSON errors are normalized and redacted', async (context) => {
  for (const providerId of protocolProviders) {
    await context.test(providerId, async () => {
      const config = configFor(providerId);
      const authAdapters = createProviderAdapterRegistry(async () =>
        jsonResponse(
          { error: { message: `Rejected ${TEST_API_KEY}` } },
          { status: 401 },
        ),
      );
      await assert.rejects(
        authAdapters[config.protocol].complete(requestFor(config)),
        (error: unknown) =>
          error instanceof Error &&
          /Authentication failed/.test(error.message) &&
          !error.message.includes(TEST_API_KEY),
      );

      const rateAdapters = createProviderAdapterRegistry(async () =>
        jsonResponse({ error: { message: 'slow down' } }, { status: 429 }),
      );
      await assert.rejects(
        rateAdapters[config.protocol].complete(requestFor(config)),
        /Rate limit reached/,
      );

      const malformedAdapters = createProviderAdapterRegistry(
        async () =>
          new Response('{bad-json', {
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      await assert.rejects(
        malformedAdapters[config.protocol].complete(requestFor(config)),
        /Malformed provider response: invalid JSON/,
      );
    });
  }
});

test('explicit model discovery parses stable protocol-specific list endpoints', async (context) => {
  const fixtures: Partial<Record<AiProviderId, unknown>> = {
    openai: { data: [{ id: 'gpt-z' }, { id: 'gpt-a' }] },
    anthropic: { data: [{ id: 'claude-z' }, { id: 'claude-a' }] },
    gemini: {
      models: [
        { name: 'models/gemini-z', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] },
      ],
    },
    cohere: { models: [{ name: 'command-z' }] },
  };
  for (const providerId of protocolProviders) {
    await context.test(providerId, async () => {
      const config = configFor(providerId);
      let calledUrl = '';
      const adapters = createProviderAdapterRegistry(async (input) => {
        calledUrl = String(input);
        return jsonResponse(fixtures[providerId]);
      });
      const models = await adapters[config.protocol].discoverModels(
        config,
        TEST_API_KEY,
      );
      assert.ok(models.length > 0);
      assert.match(calledUrl, /\/models(?:$|\?)/);
      assert.equal(
        models.some((model) => model.includes('embed-only')),
        false,
      );
    });
  }
});

test('v1 configuration migration preserves every old field and infers safely', () => {
  installMemoryStorage();
  localStorage.setItem(
    '39note.ai.provider.v1',
    JSON.stringify({
      providerLabel: 'Existing gateway',
      baseUrl: 'https://gateway.example.test/api',
      endpointPath: '/v1/chat/completions',
      model: 'existing-model',
      temperature: 0.7,
      maximumOutputTokens: 4321,
      contextCharacterBudget: 22_222,
      customHeaders: { 'X-Tenant': 'research' },
      rememberApiKey: true,
    }),
  );
  sessionStorage.setItem('39note.ai.api-key.session.v1', 'legacy-key');

  const migrated = loadAiConfiguration();
  assert.ok(migrated);
  assert.equal(migrated.providerId, 'custom-openai-compatible');
  assert.equal(migrated.protocol, 'openai-chat-completions');
  assert.equal(migrated.providerLabel, 'Existing gateway');
  assert.equal(migrated.baseUrl, 'https://gateway.example.test/api');
  assert.equal(migrated.endpointPath, '/v1/chat/completions');
  assert.equal(migrated.model, 'existing-model');
  assert.equal(migrated.temperature, 0.7);
  assert.equal(migrated.maximumOutputTokens, 4321);
  assert.equal(migrated.contextCharacterBudget, 22_222);
  assert.deepEqual(migrated.customHeaders, { 'X-Tenant': 'research' });
  assert.equal(migrated.rememberApiKey, true);
  assert.equal(loadApiKey(migrated), 'legacy-key');
  assert.equal(sessionStorage.getItem('39note.ai.api-key.session.v1'), 'legacy-key');
});

test('provider credentials are isolated, omitted from config, and fully cleared', () => {
  installMemoryStorage();
  const openAi = configFor('openai');
  const anthropic = configFor('anthropic');
  saveAiConfiguration(openAi, 'openai-secret');
  saveAiConfiguration(anthropic, 'anthropic-secret');
  assert.notEqual(getCredentialProfileId(openAi), getCredentialProfileId(anthropic));
  assert.equal(loadApiKey(openAi), 'openai-secret');
  assert.equal(loadApiKey(anthropic), 'anthropic-secret');
  assert.doesNotMatch(localStorage.getItem('39note.ai.provider.v1') ?? '', /secret/);

  const backupSource = readFileSync(
    new URL('../src/services/libraryBackup.ts', import.meta.url),
    'utf8',
  );
  const persistenceSource = readFileSync(
    new URL('../src/services/productivityPersistence.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(backupSource, /ai\.key|api-key|apiKey/);
  assert.doesNotMatch(persistenceSource, /ai\.key|api-key|apiKey/);

  clearAiConfiguration();
  assert.equal(loadApiKey(openAi), '');
  assert.equal(loadApiKey(anthropic), '');
  assert.equal(localStorage.getItem('39note.ai.provider.v1'), null);
});

function configFor(providerId: AiProviderId): AiProviderConfig {
  return {
    ...createProviderPreset(providerId, DEFAULT_AI_CONFIG),
    model: 'fixture-model',
  };
}

function requestFor(config: AiProviderConfig): ChatCompletionRequest {
  return {
    config,
    apiKey: TEST_API_KEY,
    messages: [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Prior answer' },
    ],
    stream: false,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function streamResponse(value: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, String(value));
  }
}

function installMemoryStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
}
