import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPrintSourceFingerprint } from '../src/print/printDraftModel.ts';
import { chunkDocumentPages, retrieveRelevantChunks } from '../src/ai/retrieval.ts';
import {
  formatClock,
  getDisplayedMilliseconds,
} from '../src/utils/productivityClock.ts';
import { BUILT_IN_PROMPTS } from '../src/ai/configuration.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Print Composer source fingerprint is deterministic and reacts to source Notes', () => {
  const note = {
    id: 'note-1',
    annotationId: 'anchor-1',
    pageNumber: 3,
    displayNumber: '1',
    selectedText: 'Evidence',
    content: 'Interpretation',
    createdAt: 1,
    updatedAt: 1,
  };
  const first = createPrintSourceFingerprint('Document', [note], []);
  const second = createPrintSourceFingerprint('Document', [note], []);
  const changed = createPrintSourceFingerprint(
    'Document',
    [{ ...note, content: 'Changed', updatedAt: 2 }],
    [],
  );
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.equal(note.content, 'Interpretation');
});

test('timer display uses timestamps instead of accumulating interval ticks', () => {
  const clock = {
    mode: 'timer' as const,
    status: 'running' as const,
    durationMs: 25 * 60_000,
    remainingMs: 25 * 60_000,
    accumulatedMs: 0,
    targetAt: 1_600_000,
    muted: true,
    laps: [],
  };
  assert.equal(getDisplayedMilliseconds(clock, 100_000), 1_500_000);
  assert.equal(getDisplayedMilliseconds(clock, 1_700_000), 0);
  assert.equal(formatClock(25 * 60_000), '25:00');
  assert.equal(formatClock((1 * 3_600 + 2 * 60 + 18) * 1_000), '01:02:18');
});

test('local chunking preserves page references and retrieval obeys character budget', () => {
  const chunks = chunkDocumentPages([
    {
      pageNumber: 4,
      text: 'Photosynthesis converts light energy into chemical energy. '.repeat(120),
    },
    {
      pageNumber: 7,
      text: 'Control groups support causal interpretation in experiments. '.repeat(120),
    },
  ]);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.pageNumbers.length === 1));
  const result = retrieveRelevantChunks(
    chunks,
    'Why are control groups useful?',
    4_000,
  );
  assert.ok(result.characters <= 4_000);
  assert.ok(result.pages.includes(7));
});

test('AI includes required prompt profiles and keeps request boundaries explicit', () => {
  assert.deepEqual(
    BUILT_IN_PROMPTS.map((profile) => profile.name),
    ['Evidence Only', 'Academic Explanation', 'Outline', 'Critical Reading'],
  );
  const panel = source('../src/ai/AssistantPanel.tsx');
  assert.match(panel, /SYSTEM INSTRUCTION|SECURITY BOUNDARY/);
  assert.match(panel, /DOCUMENT EXCERPTS/);
  assert.match(panel, /AbortController/);
});

test('heavy productivity modules are lazy and credentials are outside backup records', () => {
  const layout = source('../src/components/AppLayout.tsx');
  const backup = source('../src/services/libraryBackup.ts');
  const persistence = source('../src/services/productivityPersistence.ts');
  const provider = source('../src/ai/provider.ts');
  assert.match(layout, /lazy\(\(\) =>\s*import\('\.\.\/print\/PrintComposer'\)/);
  assert.match(layout, /lazy\(\(\) =>\s*import\('\.\.\/ai\/AssistantPanel'\)/);
  assert.doesNotMatch(backup, /apiKey|Authorization/);
  assert.doesNotMatch(persistence, /apiKey|Authorization/);
  assert.doesNotMatch(provider, /console\.(?:log|error|warn)/);
});

test('direct printing remains available beside edit-before-printing', () => {
  const notesPanel = source('../src/components/NotesPanel.tsx');
  assert.match(notesPanel, />\s*Edit before printing\s*</);
  assert.match(notesPanel, /onExportNotes\(printLayout\)/);
  assert.match(notesPanel, /useState<NotesPrintLayout>\(getDefaultPrintLayout\)/);
});
