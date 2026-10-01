import { BUILT_IN_PROMPTS, sanitizeConfiguration } from '../ai/configuration.ts';
import type { AiPromptProfile, AiProviderConfig } from '../ai/types.ts';

export interface SafeAiProviderConfiguration {
  providerId: AiProviderConfig['providerId'];
  protocol: AiProviderConfig['protocol'];
  providerLabel: string;
  baseUrl: string;
  endpointPath: string;
  model: string;
  temperature: number;
  maximumOutputTokens: number;
  contextCharacterBudget: number;
  qwenRegion: AiProviderConfig['qwenRegion'];
  qwenWorkspaceId: string;
}

export interface SafeAiSettingsPayload {
  configuration: SafeAiProviderConfiguration | null;
  customPromptProfiles: AiPromptProfile[];
  defaultPromptProfileId: string;
}

export function serializeSafeAiConfiguration(
  config: AiProviderConfig | null,
): SafeAiProviderConfiguration | null {
  if (!config) return null;
  const sanitized = sanitizeConfiguration(config);
  return {
    providerId: sanitized.providerId,
    protocol: sanitized.protocol,
    providerLabel: sanitized.providerLabel,
    baseUrl: sanitizeUrlWithoutSecrets(sanitized.baseUrl),
    endpointPath: sanitizeEndpointPath(sanitized.endpointPath),
    model: sanitized.model,
    temperature: sanitized.temperature,
    maximumOutputTokens: sanitized.maximumOutputTokens,
    contextCharacterBudget: sanitized.contextCharacterBudget,
    qwenRegion: sanitized.qwenRegion,
    qwenWorkspaceId: sanitized.qwenWorkspaceId,
  };
}

export function deserializeSafeAiConfiguration(
  value: unknown,
): AiProviderConfig | null {
  if (!isRecord(value)) return null;
  const allowlisted = {
    providerId: value.providerId,
    protocol: value.protocol,
    providerLabel: value.providerLabel,
    baseUrl: sanitizeUrlWithoutSecrets(value.baseUrl),
    endpointPath: sanitizeEndpointPath(value.endpointPath),
    model: value.model,
    temperature: value.temperature,
    maximumOutputTokens: value.maximumOutputTokens,
    contextCharacterBudget: value.contextCharacterBudget,
    qwenRegion: value.qwenRegion,
    qwenWorkspaceId: value.qwenWorkspaceId,
    customHeaders: {},
    rememberApiKey: false,
  };
  return sanitizeConfiguration(allowlisted);
}

export function sanitizeSafeAiSettingsPayload(
  value: unknown,
): SafeAiSettingsPayload | null {
  if (!isRecord(value) || !Array.isArray(value.customPromptProfiles)) return null;
  const configuration =
    value.configuration === null
      ? null
      : serializeSafeAiConfiguration(
          deserializeSafeAiConfiguration(value.configuration),
        );
  if (value.configuration !== null && !configuration) return null;
  const builtInIds = new Set(BUILT_IN_PROMPTS.map((profile) => profile.id));
  const seenIds = new Set<string>();
  const customPromptProfiles = value.customPromptProfiles.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.prompt !== 'string'
    ) {
      return [];
    }
    const id = candidate.id.slice(0, 128);
    if (!id || builtInIds.has(id) || seenIds.has(id)) return [];
    seenIds.add(id);
    return [
      {
        id,
        name: candidate.name.slice(0, 80),
        prompt: candidate.prompt.slice(0, 20_000),
        builtIn: false,
      },
    ];
  });
  if (customPromptProfiles.length !== value.customPromptProfiles.length) return null;
  const defaultPromptProfileId =
    typeof value.defaultPromptProfileId === 'string'
      ? value.defaultPromptProfileId.slice(0, 128)
      : BUILT_IN_PROMPTS[0].id;
  return { configuration, customPromptProfiles, defaultPromptProfileId };
}

function sanitizeUrlWithoutSecrets(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return '';
  }
}

function sanitizeEndpointPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const path = value.split(/[?#]/u, 1)[0].trim();
  return path.startsWith('/') ? path.slice(0, 2_000) : `/${path.slice(0, 1_999)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
