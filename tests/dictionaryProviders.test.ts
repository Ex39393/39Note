import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getDictionaryLookupSelection,
  getDictionaryProvider,
  getVisibleDefinitions,
  mergeDictionaryDefinitions,
  moveDefinitionUp,
} from '../src/utils/dictionary.ts';
import { runProgressiveDictionaryLookup } from '../src/utils/progressiveDictionary.ts';
import {
  NcbiRequestQueue,
  runBoundedRetry,
} from '../src/utils/ncbiRequestPolicy.ts';
import { createSharedRequestRegistry } from '../src/services/dictionary/sharedRequest.ts';
import { parseWiktionaryDefinitions } from '../src/services/dictionary/providers/wiktionaryParser.ts';
import {
  parseMeshDefinitions,
  parseMeshSearchIdentifier,
} from '../src/services/dictionary/providers/meshParser.ts';
import { createGlossaryEntryFromBubble } from '../src/utils/glossaryModel.ts';
import { sanitizePersistedGlossaryEntries } from '../src/utils/glossaryPersistence.ts';
import type {
  DefinitionBubble,
  DictionaryDefinition,
  DictionarySourceAttribution,
} from '../src/types/glossary.ts';
import type { PdfTextSelection } from '../src/types/textSelection.ts';

const viewerSource = source('../src/components/Viewer.tsx');
const pdfPageSource = source('../src/components/pdf/PdfPage.tsx');
const selectionActionSource = source('../src/components/pdf/SelectionAction.tsx');
const selectionHookSource = source('../src/hooks/usePdfTextSelection.ts');
const dictionaryServiceSource = source('../src/services/dictionaryService.ts');
const dictionaryCacheSource = source('../src/services/dictionary/dictionaryCache.ts');
const libraryBackupSource = source('../src/services/libraryBackup.ts');
const meshProviderSource = source('../src/services/dictionary/providers/mesh.ts');
const ncbiQueueSource = source('../src/services/dictionary/providers/ncbiRequestQueue.ts');
const wiktionaryProviderSource = source('../src/services/dictionary/providers/wiktionary.ts');
const notesPanelSource = source('../src/components/NotesPanel.tsx');
const dictionarySourcesDocumentation = source('../DICTIONARY_SOURCES.md');

const wordNetSource: DictionarySourceAttribution = {
  provider: 'wordnet',
  dataset: 'Princeton WordNet',
  version: '3.1',
  license: 'Princeton WordNet License',
  sourceUrl: 'https://wordnet.princeton.edu/',
  partOfSpeech: 'noun',
};
const wiktionarySource: DictionarySourceAttribution = {
  provider: 'wiktionary',
  dataset: 'English Wiktionary',
  version: 'structured-definitions-v1',
  license: 'CC BY-SA 4.0 / GFDL',
  sourceUrl: 'https://en.wiktionary.org/',
  partOfSpeech: 'noun',
  sourceId: 'term:0:0',
};
const meshSource: DictionarySourceAttribution = {
  provider: 'mesh',
  dataset: 'NLM MeSH',
  version: '2026',
  license: 'NLM MeSH Terms and Conditions',
  sourceUrl: 'https://www.nlm.nih.gov/mesh/',
  domain: 'Biomedical terminology',
  sourceId: 'D001241',
  preferredHeading: 'Aspirin',
};

test('double-click, selectionchange, and mouseup do not initiate dictionary lookup', () => {
  assert.doesNotMatch(
    pdfPageSource,
    /onDoubleClick|handleTextLayerDoubleClick|onWordLookup/,
  );
  assert.doesNotMatch(selectionHookSource, /dictionary|lookup/i);
  assert.doesNotMatch(pdfPageSource, /onMouseUp[^\n]*lookup|onPointerUp[^\n]*lookup/i);
});

test('the magnifier is the only selection-toolbar dictionary command', () => {
  assert.match(selectionActionSource, /aria-label="Look up word"/);
  assert.match(selectionActionSource, /className="dictionary-lookup-button"/);
  assert.match(selectionActionSource, /onClick=\{onLookupWord\}/);
  assert.match(viewerSource, /onLookupWord=/);
  assert.match(viewerSource, /activateDictionaryLookup/);
});

test('valid single-word selections expose lookup while phrases do not', () => {
  assert.equal(
    getDictionaryLookupSelection([selection('reinforcement')])?.text,
    'reinforcement',
  );
  assert.equal(
    getDictionaryLookupSelection([selection('“pubescence,”')])?.text,
    'pubescence',
  );
  assert.equal(
    getDictionaryLookupSelection([selection("participant's")])?.text,
    "participant's",
  );
  assert.equal(
    getDictionaryLookupSelection([selection('evidence-based')])?.text,
    'evidence-based',
  );
  assert.equal(getDictionaryLookupSelection([selection('two words')]), null);
  assert.equal(getDictionaryLookupSelection([selection('42.5')]), null);
  assert.equal(getDictionaryLookupSelection([selection('!!!')]), null);
});

test('lookup activation preserves stable page geometry and offsets', () => {
  const original = selection('(glabrous)');
  const lookup = getDictionaryLookupSelection([original]);
  assert.ok(lookup);
  assert.equal(lookup.text, 'glabrous');
  assert.equal(lookup.pageNumber, original.pageNumber);
  assert.deepEqual(lookup.boundingRectangles, original.boundingRectangles);
  assert.equal(lookup.startOffset, original.startOffset);
  assert.equal(lookup.endOffset, original.endOffset);
});

test('Wiktionary parser keeps English definitions, strips markup, and preserves source metadata', () => {
  const definitions = parseWiktionaryDefinitions(
    {
      en: [
        {
          language: 'English',
          partOfSpeech: 'Adjective',
          definitions: [
            {
              definition:
                '<a href="/wiki/bald">Bald</a>, <b>hairless</b>; smooth &amp; bare.',
              examples: ['An unused quotation.'],
            },
          ],
        },
      ],
      fr: [
        {
          language: 'French',
          partOfSpeech: 'Adjective',
          definitions: [{ definition: 'Une définition française.' }],
        },
      ],
    },
    'glabrous',
  );
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].text, 'Bald, hairless; smooth & bare.');
  assert.equal(definitions[0].partOfSpeech, 'adjective');
  assert.equal(getDictionaryProvider(definitions[0].source), 'wiktionary');
  assert.equal(definitions[0].source.sourceId, 'glabrous:0:0');
  assert.doesNotMatch(definitions[0].text, /quotation|<|>/i);
});

test('Wiktionary parser rejects non-English and malformed definition structures', () => {
  assert.deepEqual(
    parseWiktionaryDefinitions(
      { en: [{ language: 'German', definitions: [{ definition: 'Falsch' }] }] },
      'term',
    ),
    [],
  );
  assert.deepEqual(parseWiktionaryDefinitions({ fr: [] }, 'term'), []);
});

test('MeSH parser accepts one exact useful Scope Note', () => {
  assert.equal(
    parseMeshSearchIdentifier({ esearchresult: { idlist: ['68007052'] } }),
    '68007052',
  );
  const definitions = parseMeshDefinitions(
    {
      result: {
        '68007052': {
          uid: '68007052',
          ds_meshui: 'D007052',
          ds_meshterms: ['Ibuprofen', 'Advil'],
          ds_scopenote: 'A non-steroidal anti-inflammatory agent.',
        },
      },
    },
    'advil',
    '68007052',
  );
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].text, 'A non-steroidal anti-inflammatory agent.');
  assert.equal(getDictionaryProvider(definitions[0].source), 'mesh');
  assert.equal(definitions[0].source.sourceId, 'D007052');
});

test('MeSH parser rejects ambiguous, irrelevant, and empty records', () => {
  assert.equal(
    parseMeshSearchIdentifier({ esearchresult: { idlist: ['1', '2'] } }),
    null,
  );
  const baseRecord = {
    uid: '68007052',
    ds_meshui: 'D007052',
    ds_meshterms: ['Ibuprofen', 'Advil'],
  };
  assert.deepEqual(
    parseMeshDefinitions(
      { result: { '68007052': { ...baseRecord, ds_scopenote: 'Useful.' } } },
      'unrelated',
      '68007052',
    ),
    [],
  );
  assert.deepEqual(
    parseMeshDefinitions(
      { result: { '68007052': { ...baseRecord, ds_scopenote: '' } } },
      'advil',
      '68007052',
    ),
    [],
  );
});

test('exact and strongly near-identical definitions are conservatively deduplicated', () => {
  const wordnet = definition('wordnet', 'A smooth hairless surface.', wordNetSource);
  const exactWiki = definition('wiki', 'A smooth hairless surface.', wiktionarySource);
  const differentWiki = definition(
    'wiki-2',
    'A plant surface lacking trichomes.',
    wiktionarySource,
  );
  assert.deepEqual(
    mergeDictionaryDefinitions([wordnet], [exactWiki, differentWiki]).map(
      (candidate) => candidate.id,
    ),
    ['wordnet', 'wiki-2'],
  );
  const mesh = definition('mesh', 'A smooth hairless surface', meshSource);
  assert.equal(mergeDictionaryDefinitions([wordnet], [mesh])[0].id, 'mesh');
});

test('manual ordering and expanded state survive asynchronous provider arrival', () => {
  const initial = [
    definition('a', 'Sense A.', wordNetSource),
    definition('b', 'Sense B.', wordNetSource),
    definition('c', 'Sense C.', wordNetSource),
  ];
  const promoted = moveDefinitionUp(moveDefinitionUp(initial, 'c'), 'c');
  const merged = mergeDictionaryDefinitions(promoted, [
    definition('d', 'Sense D.', wiktionarySource),
  ]);
  assert.deepEqual(
    merged.map((candidate) => candidate.id),
    ['c', 'a', 'b', 'd'],
  );
  assert.deepEqual(getVisibleDefinitions(merged, true), merged);
  assert.equal(getVisibleDefinitions(merged, false).length, 3);
});

test('WordNet results are delivered before unresolved remote providers', async () => {
  const events: string[] = [];
  const remote = deferred<DictionaryDefinition[]>();
  const controller = new AbortController();
  const lookup = runProgressiveDictionaryLookup({
    fallbackNormalizedWord: 'term',
    localLookup: async () => ({
      normalizedWord: 'term',
      definitions: [definition('local', 'Local.', wordNetSource)],
    }),
    generalLookups: [() => remote.promise],
    callbacks: {
      onLocalResult: () => events.push('local'),
      onRemoteResult: () => events.push('remote'),
      onComplete: () => events.push('complete'),
    },
    signal: controller.signal,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['local']);
  remote.resolve([definition('remote', 'Remote.', wiktionarySource)]);
  await lookup;
  assert.deepEqual(events, ['local', 'remote', 'complete']);
});

test('useful general coverage prevents unnecessary MeSH fallback', async () => {
  let specialistCalls = 0;
  const events: string[] = [];
  await runProgressiveDictionaryLookup({
    fallbackNormalizedWord: 'participant',
    localLookup: async () => ({
      normalizedWord: 'participant',
      definitions: [definition('local', 'Someone who takes part.', wordNetSource)],
    }),
    generalLookups: [async () => [definition('wiki', 'One who participates.', wiktionarySource)]],
    specialistLookup: async () => {
      specialistCalls += 1;
      return [definition('mesh', 'Specialist.', meshSource)];
    },
    callbacks: {
      onLocalResult: () => events.push('local'),
      onRemoteResult: () => events.push('remote'),
      onComplete: () => events.push('complete'),
    },
    signal: new AbortController().signal,
  });
  assert.equal(specialistCalls, 0);
  assert.deepEqual(events, ['local', 'remote', 'complete']);
});

test('empty general coverage allows MeSH only after Wiktionary completes', async () => {
  const events: string[] = [];
  await runProgressiveDictionaryLookup({
    fallbackNormalizedWord: 'specialistterm',
    localLookup: async () => ({ normalizedWord: 'specialistterm', definitions: [] }),
    generalLookups: [async () => {
      events.push('wiktionary');
      return [];
    }],
    specialistLookup: async () => {
      events.push('mesh');
      return [definition('mesh', 'Specialist definition.', meshSource)];
    },
    callbacks: {
      onLocalResult: () => events.push('local'),
      onRemoteResult: () => events.push('remote'),
      onComplete: () => events.push('complete'),
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(events, ['local', 'wiktionary', 'mesh', 'remote', 'complete']);
});

test('remote failure preserves WordNet and offline mode completes locally', async () => {
  const events: string[] = [];
  const controller = new AbortController();
  await runProgressiveDictionaryLookup({
    fallbackNormalizedWord: 'term',
    localLookup: async () => ({
      normalizedWord: 'term',
      definitions: [definition('local', 'Local.', wordNetSource)],
    }),
    generalLookups: [async () => Promise.reject(new Error('offline'))],
    callbacks: {
      onLocalResult: (result) => events.push(`local:${result.definitions.length}`),
      onRemoteResult: () => events.push('remote'),
      onComplete: () => events.push('complete'),
    },
    signal: controller.signal,
  });
  assert.deepEqual(events, ['local:1', 'complete']);

  const offlineEvents: string[] = [];
  await runProgressiveDictionaryLookup({
    fallbackNormalizedWord: 'term',
    localLookup: async () => ({ normalizedWord: 'term', definitions: [] }),
    generalLookups: [],
    callbacks: {
      onLocalResult: () => offlineEvents.push('local'),
      onRemoteResult: () => offlineEvents.push('remote'),
      onComplete: () => offlineEvents.push('complete'),
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(offlineEvents, ['local', 'complete']);
});

test('closing a lookup prevents stale remote callbacks', async () => {
  const events: string[] = [];
  const remote = deferred<DictionaryDefinition[]>();
  const controller = new AbortController();
  const lookup = runProgressiveDictionaryLookup({
    fallbackNormalizedWord: 'term',
    localLookup: async () => ({ normalizedWord: 'term', definitions: [] }),
    generalLookups: [() => remote.promise],
    callbacks: {
      onLocalResult: () => events.push('local'),
      onRemoteResult: () => events.push('remote'),
      onComplete: () => events.push('complete'),
    },
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  remote.resolve([definition('remote', 'Remote.', wiktionarySource)]);
  await lookup;
  assert.deepEqual(events, ['local']);
});

test('simultaneous identical provider requests share one network operation', async () => {
  const registry = createSharedRequestRegistry<string>();
  const result = deferred<string>();
  let calls = 0;
  const factory = async () => {
    calls += 1;
    return result.promise;
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = registry.request('wiktionary:v1:term', factory, firstController.signal);
  const second = registry.request(
    'wiktionary:v1:term',
    factory,
    secondController.signal,
  );
  assert.equal(calls, 1);
  firstController.abort();
  result.resolve('shared');
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await second, 'shared');
  assert.equal(registry.size(), 0);
});

test('NCBI queue serializes starts below three E-utilities requests per second', async () => {
  let now = 0;
  const starts: number[] = [];
  const waits: number[] = [];
  const queue = new NcbiRequestQueue(
    350,
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );
  const signal = new AbortController().signal;
  await Promise.all(
    [1, 2, 3].map((value) =>
      queue.schedule(async () => {
        starts.push(now);
        return value;
      }, signal),
    ),
  );
  assert.deepEqual(starts, [0, 350, 700]);
  assert.deepEqual(waits, [350, 350]);
});

test('AbortController cancels queued NCBI work before it starts', async () => {
  const first = deferred<string>();
  let secondStarted = false;
  const queue = new NcbiRequestQueue(0);
  const firstRequest = queue.schedule(() => first.promise, new AbortController().signal);
  const secondController = new AbortController();
  const secondRequest = queue.schedule(async () => {
    secondStarted = true;
    return 'second';
  }, secondController.signal);
  secondController.abort();
  first.resolve('first');
  assert.equal(await firstRequest, 'first');
  await assert.rejects(secondRequest, { name: 'AbortError' });
  assert.equal(secondStarted, false);
});

test('HTTP 429/transient retry uses bounded exponential backoff', async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await runBoundedRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw { status: 429, retryAfterMs: calls === 1 ? 800 : null };
      return 'ok';
    },
    new AbortController().signal,
    {
      maxAttempts: 3,
      baseBackoffMs: 500,
      maxBackoffMs: 2_000,
      isTransient: (error) => (error as { status?: number }).status === 429,
      getRetryAfterMs: (error) => (error as { retryAfterMs?: number | null }).retryAfterMs ?? null,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [800, 1_000]);
});

test('provider identification and privacy wording remain provider-specific', () => {
  assert.match(wiktionaryProviderSource, /'Api-User-Agent'/);
  assert.match(wiktionaryProviderSource, /39Note\/0\.1\.0 \(https:\/\/github\.com\/Ex39393\/39Note\)/);
  assert.match(meshProviderSource, /searchParams\.set\('tool', '39Note'\)/);
  assert.doesNotMatch(meshProviderSource, /searchParams\.set\('email'/);
  assert.match(ncbiQueueSource, /runBoundedRetry/);
  assert.match(notesPanelSource, /Normal network metadata may still be/);
  assert.match(dictionarySourcesDocumentation, /Normal network metadata may still be visible/);
  assert.doesNotMatch(dictionarySourcesDocumentation, /never sends.*user identity/i);
});

test('Glossary stores the current top definition and remote attribution', () => {
  const top = definition('wik-top', 'Preferred remote sense.', wiktionarySource);
  const bubble: DefinitionBubble = {
    id: 'bubble',
    documentId: 'document-12345678',
    pageNumber: 3,
    displayedWord: 'glabrous',
    normalizedLookupWord: 'glabrous',
    rects: [{ x: 0.1, y: 0.2, width: 0.1, height: 0.03 }],
    startOffset: 2,
    endOffset: 10,
    definitions: [top, definition('wordnet', 'Other sense.', wordNetSource)],
    status: 'ready',
    isExpanded: false,
  };
  const entry = createGlossaryEntryFromBubble(
    'document-12345678',
    bubble,
    top,
    100,
    'entry-1',
    'marker-1',
  );
  assert.equal(entry.definition, 'Preferred remote sense.');
  assert.equal(getDictionaryProvider(entry.source), 'wiktionary');
  assert.equal(entry.source.sourceId, 'term:0:0');
});

test('remote Glossary source metadata survives Backup/Restore sanitization', () => {
  const raw = {
    glossaryEntryId: 'entry-1',
    documentId: 'document-12345678',
    displayedWord: 'Aspirin',
    normalizedLookupWord: 'aspirin',
    definition: 'A specialist definition.',
    pageNumber: 1,
    sourceRects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 }],
    startOffset: 1,
    endOffset: 8,
    createdAt: 1,
    source: meshSource,
    markerAnnotationId: 'marker-1',
  };
  const restored = sanitizePersistedGlossaryEntries([raw], 'document-12345678');
  assert.equal(restored.length, 1);
  assert.equal(getDictionaryProvider(restored[0].source), 'mesh');
  assert.equal(restored[0].source.sourceId, 'D001241');
});

test('remote cache is versioned, separate, clearable, and excluded from Library backup', () => {
  assert.match(dictionaryCacheSource, /39note-dictionary-cache/);
  assert.match(dictionaryCacheSource, /providerVersion/);
  assert.match(dictionaryCacheSource, /30 \* 24 \* 60 \* 60 \* 1_000/);
  assert.match(dictionaryCacheSource, /export async function clearDictionaryCache/);
  assert.doesNotMatch(libraryBackupSource, /39note-dictionary-cache|remote-results/);
});

test('WordNet remains first, local, lazy, and GitHub Pages base-path aware', () => {
  assert.match(
    dictionaryServiceSource,
    /localLookup: \(\) => lookupLocalDictionary\(word\)/,
  );
  assert.match(dictionaryServiceSource, /import\.meta\.env\.BASE_URL/);
  assert.match(dictionaryServiceSource, /dictionary\/\$\{shardKey\}\.json/);
  assert.match(viewerSource, /import\('\.\.\/services\/dictionaryService'\)/);
});

function selection(text: string): PdfTextSelection {
  return {
    text,
    pageNumber: 2,
    boundingRectangles: [{ x: 20, y: 40, width: 90, height: 14 }],
    startOffset: 4,
    endOffset: 13,
    pageWidth: 600,
    pageHeight: 800,
  };
}

function definition(
  id: string,
  text: string,
  definitionSource: DictionarySourceAttribution,
): DictionaryDefinition {
  return { id, text, source: definitionSource };
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
