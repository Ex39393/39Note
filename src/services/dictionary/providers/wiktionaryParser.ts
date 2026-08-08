import type { DictionaryDefinition } from '../../../types/glossary';

export const WIKTIONARY_PROVIDER_VERSION = 'structured-definitions-v1';

export function parseWiktionaryDefinitions(
  value: unknown,
  normalizedWord: string,
): DictionaryDefinition[] {
  if (!isRecord(value) || !Array.isArray(value.en)) return [];
  const definitions: DictionaryDefinition[] = [];

  value.en.forEach((entry, entryIndex) => {
    if (
      !isRecord(entry) ||
      entry.language !== 'English' ||
      !Array.isArray(entry.definitions)
    ) {
      return;
    }
    const partOfSpeech = cleanPlainText(entry.partOfSpeech, 80);
    entry.definitions.forEach((candidate, definitionIndex) => {
      if (!isRecord(candidate)) return;
      const text = cleanDefinitionHtml(candidate.definition);
      if (!text) return;
      const sourceId = `${normalizedWord}:${entryIndex}:${definitionIndex}`;
      definitions.push({
        id: `wiktionary:${sourceId}`,
        text,
        ...(partOfSpeech
          ? { partOfSpeech: partOfSpeech.toLocaleLowerCase('en-US') }
          : {}),
        source: {
          provider: 'wiktionary',
          dataset: 'English Wiktionary',
          version: WIKTIONARY_PROVIDER_VERSION,
          license: 'CC BY-SA 4.0 / GFDL',
          sourceUrl: 'https://en.wiktionary.org/',
          ...(partOfSpeech
            ? { partOfSpeech: partOfSpeech.toLocaleLowerCase('en-US') }
            : {}),
          sourceId,
        },
      });
    });
  });

  return definitions;
}

function cleanDefinitionHtml(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const withoutUnsafeBlocks = value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return cleanPlainText(decodeHtmlEntities(withoutUnsafeBlocks), 1_200);
}

function cleanPlainText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replaceAll(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  return cleaned.length > 0 && cleaned.length <= maximumLength ? cleaned : null;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith('#x')) {
      return safeCodePoint(Number.parseInt(code.slice(2), 16), entity);
    }
    if (code.startsWith('#')) {
      return safeCodePoint(Number.parseInt(code.slice(1), 10), entity);
    }
    return namedEntities[code.toLocaleLowerCase('en-US')] ?? entity;
  });
}

function safeCodePoint(codePoint: number, fallback: string): string {
  return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
