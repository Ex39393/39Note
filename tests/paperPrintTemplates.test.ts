import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import {
  combinePaperPayloads,
  createPaperManifestGeneration,
  partitionPaperSnapshot,
} from '../src/sync/paperCloudFormat.ts';
import { sha256Hex, stableStringify } from '../src/sync/hash.ts';
import {
  PAPER_MANIFEST_STORAGE,
  PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_PAYLOAD_STORAGE,
  PAPER_SYNC_PROTOCOL_VERSION,
} from '../src/sync/paperTypes.ts';
import {
  createSyncEntityKey,
  SYNC_SCHEMA_VERSION,
  type SyncEntityRecord,
  type SyncSnapshot,
} from '../src/sync/types.ts';
import {
  BUILT_IN_PRINT_TEMPLATES,
  createDefaultPrintPresentation,
  getPrintContentLayout,
  getPrintTemplateCss,
  normalizeLegacyPrintLayout,
  normalizePrintPresentation,
  resolvePrintTemplateSettings,
  sanitizePrintTemplateOverrides,
} from '../src/print/printTemplates.ts';
import {
  createPrintDraftHash,
  isRenderedPrintPdfStale,
} from '../src/print/printDraftModel.ts';
import {
  classifyRenderedPrintPdf,
  createStoredRenderedPrintPdf,
  replaceAndVerifyStoredRenderedPrintPdf,
  resolveStoredRenderedPrintPdfForDownload,
} from '../src/print/renderedPrintPdf.ts';
import {
  createSourceChangeNoticeKey,
  INITIAL_PRINT_COMPOSER_UI_STATE,
  reducePrintComposerUiState,
  shouldShowSourceChangeNotice,
} from '../src/print/printComposerUiState.ts';
import {
  PRINT_DRAFT_SCHEMA_VERSION,
  type PrintDraftRecord,
  type RenderedPrintPdfDescriptor,
  type StoredRenderedPrintPdf,
} from '../src/types/productivity.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
let server: ViteDevServer;
let sanitizeProductivityBackupData: (typeof import('../src/services/productivityPersistence.ts'))['sanitizeProductivityBackupData'];

before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  const module = (await server.ssrLoadModule(
    '/src/services/productivityPersistence.ts',
  )) as typeof import('../src/services/productivityPersistence.ts');
  sanitizeProductivityBackupData = module.sanitizeProductivityBackupData;
});

after(async () => server.close());

test('editable Print Draft and formal templates remain paper-scoped and truthful', async (context) => {
  await context.test(
    'Print Draft is partitioned into the paper productivity payload and restores',
    async () => {
      const draft = printDraft();
      const record = await syncEntity('print-draft', 'doc-a', 'doc-a', draft);
      const snapshot = syncSnapshot([
        await syncEntity('document', 'doc-a', undefined, { title: 'Paper' }),
        record,
      ]);
      const partitions = partitionPaperSnapshot(snapshot, 'doc-a');
      assert.equal(
        partitions.state.entities.some((entity) => entity.kind === 'print-draft'),
        false,
      );
      assert.equal(partitions.productivity.entities[0].value, draft);
      const manifest = await paperManifest();
      const restored = combinePaperPayloads(
        manifest,
        partitions.state,
        partitions.productivity,
      );
      assert.deepEqual(
        restored.entities.find((entity) => entity.kind === 'print-draft')?.value,
        draft,
      );
    },
  );

  await context.test(
    'selected template and overrides sanitize for another device',
    () => {
      const draft = printDraft({
        baseTemplateId: 'space-saving',
        overrides: { bodyFontSizePt: 10.5 },
      });
      const restored = sanitizeProductivityBackupData(
        { documentId: 'doc-a', printDraft: draft, aiConversations: [] },
        'doc-a',
      );
      assert.equal(restored?.printDraft?.baseTemplateId, 'space-saving');
      assert.deepEqual(restored?.printDraft?.overrides, { bodyFontSizePt: 10.5 });
    },
  );

  await context.test('Normal remains the stable default template', () => {
    assert.equal(createDefaultPrintPresentation().baseTemplateId, 'normal');
    assert.equal(BUILT_IN_PRINT_TEMPLATES[0].id, 'normal');
  });

  await context.test('built-in template IDs and version are stable', () => {
    assert.deepEqual(
      BUILT_IN_PRINT_TEMPLATES.map(({ id }) => id),
      ['normal', 'space-saving', 'extra-large'],
    );
    assert.ok(BUILT_IN_PRINT_TEMPLATES.every(({ version }) => version === 1));
  });

  await context.test('Space-saving changes presentation only', () => {
    const original = printDraft();
    const changed = { ...original, baseTemplateId: 'space-saving' as const };
    assert.equal(changed.editorStateJson, original.editorStateJson);
    assert.deepEqual(changed.pendingAdditions, original.pendingAdditions);
    assert.ok(
      resolvePrintTemplateSettings(changed).bodyFontSizePt <
        resolvePrintTemplateSettings(original).bodyFontSizePt,
    );
  });

  await context.test('Extra Large changes presentation only', () => {
    const original = printDraft();
    const changed = { ...original, baseTemplateId: 'extra-large' as const };
    assert.equal(changed.editorStateJson, original.editorStateJson);
    assert.deepEqual(changed.pendingAdditions, original.pendingAdditions);
    assert.ok(
      resolvePrintTemplateSettings(changed).bodyFontSizePt >
        resolvePrintTemplateSettings(original).bodyFontSizePt,
    );
  });

  await context.test('template switching never changes content mode', () => {
    const original = printDraft({ contentMode: 'all-annotations' });
    const changed = { ...original, baseTemplateId: 'space-saving' as const };
    assert.equal(changed.contentMode, 'all-annotations');
    assert.equal(getPrintContentLayout(changed), 'space-saving');
  });

  await context.test(
    'legacy all-annotations becomes content mode, not a presentation template',
    () => {
      const migrated = normalizeLegacyPrintLayout('all-annotations');
      assert.equal(migrated.contentMode, 'all-annotations');
      assert.equal(migrated.baseTemplateId, 'normal');
    },
  );

  await context.test(
    'template overrides are bounded and unknown controls fail closed',
    () => {
      assert.deepEqual(sanitizePrintTemplateOverrides({ bodyFontSizePt: 11 }), {
        bodyFontSizePt: 11,
      });
      assert.equal(sanitizePrintTemplateOverrides({ bodyFontSizePt: 100 }), null);
      assert.equal(sanitizePrintTemplateOverrides({ unsupported: 1 }), null);
    },
  );

  await context.test(
    'legacy print layouts migrate without changing editor content',
    () => {
      const value = normalizePrintPresentation({ layout: 'space-saving' });
      assert.equal(value?.baseTemplateId, 'space-saving');
      assert.equal(value?.contentMode, 'notes-and-glossary');
    },
  );

  await context.test(
    'template CSS is derived from authoritative template settings',
    () => {
      const css = getPrintTemplateCss({
        ...createDefaultPrintPresentation(),
        baseTemplateId: 'extra-large',
      });
      assert.match(css, /font-size: 16pt/u);
      assert.match(css, /print-layout-extra-large/u);
    },
  );

  await context.test(
    'draft hash changes for content, template, and override changes',
    async () => {
      const original = printDraft();
      const hashes = await Promise.all([
        createPrintDraftHash(original),
        createPrintDraftHash({ ...original, editorStateJson: '{"changed":true}' }),
        createPrintDraftHash({ ...original, baseTemplateId: 'space-saving' }),
        createPrintDraftHash({ ...original, overrides: { bodyFontSizePt: 11 } }),
      ]);
      assert.equal(new Set(hashes).size, hashes.length);
    },
  );

  await context.test(
    'draft hash ignores save timestamps that cannot change rendered bytes',
    async () => {
      const original = printDraft();
      assert.equal(
        await createPrintDraftHash(original),
        await createPrintDraftHash({ ...original, updatedAt: 99, lastSavedAt: 100 }),
      );
    },
  );

  await context.test(
    'rendered Print PDF becomes stale when editable draft changes',
    async () => {
      const draft = printDraft();
      const artifact = renderedDescriptor(await createPrintDraftHash(draft));
      assert.equal(await isRenderedPrintPdfStale(draft, artifact), false);
      assert.equal(
        await isRenderedPrintPdfStale(
          { ...draft, editorStateJson: '{"new":true}' },
          artifact,
        ),
        true,
      );
    },
  );

  await context.test(
    'browser print dialog does not fabricate a rendered PDF artifact',
    () => {
      const composer = source('../src/print/PrintComposer.tsx');
      const output = source('../src/print/printComposerOutput.ts');
      assert.match(output, /\.print\(\)/u);
      assert.doesNotMatch(`${composer}\n${output}`, /renderedFromDraftHash\s*:/u);
      assert.doesNotMatch(`${composer}\n${output}`, /new Blob\([^)]*application\/pdf/u);
    },
  );

  await context.test(
    'rendered Print PDF model requires an independently hashed real PDF',
    () => {
      const artifact = renderedDescriptor('a'.repeat(64));
      assert.equal(artifact.kind, 'rendered-print-pdf');
      assert.equal(artifact.mimeType, 'application/pdf');
      assert.equal(artifact.fileName, 'Paper - Print.pdf');
    },
  );

  await context.test(
    'replacement verifies persisted artifact B and remount/download resolve B',
    async () => {
      const draftA = printDraft();
      const sourcePdf = new Blob(['%PDF-1.7\nsource paper\n%%EOF'], {
        type: 'application/pdf',
      });
      const sourcePdfHash = await sha256Hex(sourcePdf);
      const blobA = new Blob(['%PDF-1.7\nartifact A\n%%EOF'], {
        type: 'application/pdf',
      });
      const artifactA = await createStoredRenderedPrintPdf(
        'doc-a',
        'Paper',
        draftA,
        blobA,
        10,
      );
      assert.equal(await classifyRenderedPrintPdf(draftA, artifactA), 'current');

      const draftB = { ...draftA, editorStateJson: '{"changed":true}' };
      const draftBeforeReplacement = structuredClone(draftB);
      assert.equal(await classifyRenderedPrintPdf(draftB, artifactA), 'stale');
      const blobB = new Blob(['%PDF-1.7\nartifact B\n%%EOF'], {
        type: 'application/pdf',
      });
      const artifactB = await createStoredRenderedPrintPdf(
        'doc-a',
        'Paper',
        draftB,
        blobB,
        20,
      );
      let stored: StoredRenderedPrintPdf | null = artifactA;
      const events: string[] = [];
      const gateway = {
        load: async () => {
          events.push(`load-${stored?.sha256 ?? 'missing'}`);
          return stored ? cloneRenderedPrintPdf(stored) : null;
        },
        save: async (artifact: StoredRenderedPrintPdf) => {
          events.push(`save-${artifact.sha256}`);
          stored = cloneRenderedPrintPdf(artifact);
        },
        remove: async () => {
          events.push('remove');
          stored = null;
        },
      };
      const persistedArtifact = await replaceAndVerifyStoredRenderedPrintPdf(
        artifactB,
        gateway,
      );
      assert.equal(events[0], `load-${artifactA.sha256}`);
      assert.equal(events[1], `save-${artifactB.sha256}`);
      assert.equal(events[2], `load-${artifactB.sha256}`);
      assert.notEqual(persistedArtifact, artifactB);
      assert.equal(persistedArtifact.sha256, artifactB.sha256);
      assert.equal(await persistedArtifact.blob.text(), await blobB.text());

      const remountedArtifact = await gateway.load();
      assert.ok(remountedArtifact);
      const downloadedArtifact = await resolveStoredRenderedPrintPdfForDownload(
        remountedArtifact,
        gateway.load,
      );
      assert.equal(
        await classifyRenderedPrintPdf(draftB, downloadedArtifact),
        'current',
      );
      assert.equal(await downloadedArtifact.blob.text(), await blobB.text());
      assert.notEqual(await downloadedArtifact.blob.text(), await blobA.text());
      assert.equal(downloadedArtifact.sha256, await sha256Hex(blobB));
      assert.notEqual(downloadedArtifact.sha256, artifactA.sha256);
      assert.equal(await sha256Hex(sourcePdf), sourcePdfHash);
      assert.deepEqual(draftB, draftBeforeReplacement);
    },
  );

  await context.test(
    'replacement failures keep artifact A stale and verify rollback before returning',
    async () => {
      const draftA = printDraft();
      const draftB = { ...draftA, editorStateJson: '{"changed":true}' };
      const artifactA = await createStoredRenderedPrintPdf(
        'doc-a',
        'Paper',
        draftA,
        new Blob(['%PDF-1.7\nartifact A\n%%EOF'], { type: 'application/pdf' }),
        10,
      );
      const artifactB = await createStoredRenderedPrintPdf(
        'doc-a',
        'Paper',
        draftB,
        new Blob(['%PDF-1.7\nartifact B\n%%EOF'], { type: 'application/pdf' }),
        20,
      );
      let stored: StoredRenderedPrintPdf | null = artifactA;
      let saveCalls = 0;
      await assert.rejects(
        replaceAndVerifyStoredRenderedPrintPdf(artifactB, {
          load: async () => (stored ? cloneRenderedPrintPdf(stored) : null),
          save: async (artifact) => {
            saveCalls += 1;
            if (saveCalls === 1) throw new Error('injected transaction failure');
            stored = cloneRenderedPrintPdf(artifact);
          },
          remove: async () => {
            stored = null;
          },
        }),
        /previous saved Print PDF was restored/iu,
      );
      assert.equal(stored?.sha256, artifactA.sha256);
      assert.equal(await classifyRenderedPrintPdf(draftB, stored), 'stale');

      let returnWrongReadback = true;
      await assert.rejects(
        replaceAndVerifyStoredRenderedPrintPdf(artifactB, {
          load: async () => {
            if (stored?.sha256 === artifactB.sha256 && returnWrongReadback) {
              returnWrongReadback = false;
              return cloneRenderedPrintPdf(artifactA);
            }
            return stored ? cloneRenderedPrintPdf(stored) : null;
          },
          save: async (artifact) => {
            stored = cloneRenderedPrintPdf(artifact);
          },
          remove: async () => {
            stored = null;
          },
        }),
        /previous saved Print PDF was restored/iu,
      );
      assert.equal(stored?.sha256, artifactA.sha256);
      assert.equal(await classifyRenderedPrintPdf(draftB, stored), 'stale');
    },
  );
});

test('production Print PDF persistence replaces A with verified B across remount', async () => {
  const idbSymbol = Symbol.for('39note.test.print-pdf-replacement-idb');
  const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const originalHarness = Object.getOwnPropertyDescriptor(globalThis, idbSymbol);
  const records = new Map<string, StoredRenderedPrintPdf>();
  Object.defineProperty(globalThis, idbSymbol, {
    configurable: true,
    value: { records },
  });
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {},
  });
  const { createServer } = await import('vite');
  const persistenceServer = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        name: 'print-pdf-replacement-idb-test-double',
        enforce: 'pre',
        resolveId(id) {
          return id === 'idb' ? '\0print-pdf-replacement-idb' : undefined;
        },
        load(id) {
          if (id !== '\0print-pdf-replacement-idb') return undefined;
          return `
            const records = () => globalThis[Symbol.for('39note.test.print-pdf-replacement-idb')].records;
            const clone = (value) => value === undefined ? undefined : structuredClone(value);
            export async function openDB() {
              return {
                objectStoreNames: { contains: () => true },
                async get(_storeName, key) { return clone(records().get(key)); },
                async put(_storeName, value) { records().set(value.documentId, clone(value)); },
                async delete(_storeName, key) { records().delete(key); },
                transaction() {
                  return {
                    store: {
                      async get(key) { return clone(records().get(key)); },
                      async put(value) { records().set(value.documentId, clone(value)); },
                      async delete(key) { records().delete(key); },
                    },
                    done: Promise.resolve(),
                    abort() {},
                  };
                },
                close() {},
              };
            }
            export async function deleteDB() {}
          `;
        },
      },
    ],
    ssr: { noExternal: ['idb'] },
    server: { middlewareMode: true },
  });
  try {
    const persistence = (await persistenceServer.ssrLoadModule(
      '/src/services/productivityPersistence.ts',
    )) as typeof import('../src/services/productivityPersistence.ts');
    const draftA = printDraft();
    const draftB = { ...draftA, editorStateJson: '{"changed":true}' };
    const artifactA = await createStoredRenderedPrintPdf(
      'doc-a',
      'Paper',
      draftA,
      new Blob(['%PDF-1.7\nartifact A visible text\n%%EOF'], {
        type: 'application/pdf',
      }),
      10,
    );
    const artifactB = await createStoredRenderedPrintPdf(
      'doc-a',
      'Paper',
      draftB,
      new Blob(['%PDF-1.7\nartifact B visible text\n%%EOF'], {
        type: 'application/pdf',
      }),
      20,
    );
    assert.equal(await persistence.saveRenderedPrintPdf(artifactA, false), true);
    const capturedArtifactA =
      await persistence.captureRenderedPrintPdfStorageIdentity('doc-a');
    assert.equal(capturedArtifactA.value.state, 'stored');
    assert.equal(
      capturedArtifactA.value.state === 'stored'
        ? capturedArtifactA.value.sha256
        : undefined,
      artifactA.sha256,
    );
    assert.equal(
      await persistence.restoreRenderedPrintPdfIfUnchanged(
        'doc-a',
        capturedArtifactA,
        artifactA,
        false,
      ),
      true,
    );
    const verifiedB = await persistence.replaceRenderedPrintPdf(artifactB);
    assert.equal(verifiedB.sha256, artifactB.sha256);
    assert.equal(await verifiedB.blob.text(), await artifactB.blob.text());
    assert.notEqual(verifiedB.sha256, artifactA.sha256);
    assert.equal(
      await persistence.restoreRenderedPrintPdfIfUnchanged(
        'doc-a',
        capturedArtifactA,
        artifactA,
        false,
      ),
      false,
    );
    assert.equal(
      (await persistence.loadRenderedPrintPdf('doc-a'))?.sha256,
      artifactB.sha256,
    );

    await persistence.closeProductivityPersistenceWorkspace();
    const remountedB = await persistence.loadRenderedPrintPdf('doc-a');
    assert.ok(remountedB);
    const downloadedB = await resolveStoredRenderedPrintPdfForDownload(remountedB, () =>
      persistence.loadRenderedPrintPdf('doc-a'),
    );
    assert.equal(await downloadedB.blob.text(), await artifactB.blob.text());
    assert.equal(await sha256Hex(downloadedB.blob), artifactB.sha256);
    assert.notEqual(await sha256Hex(downloadedB.blob), artifactA.sha256);
  } finally {
    await persistenceServer.close();
    restoreGlobalProperty('indexedDB', originalIndexedDb);
    restoreGlobalProperty(idbSymbol, originalHarness);
  }
});

test('Print Composer drawers and source notice remain presentation-only UI state', async () => {
  const draft = printDraft();
  const originalHash = await createPrintDraftHash(draft);
  const firstKey = createSourceChangeNoticeKey('source-2', 2);
  const nextKey = createSourceChangeNoticeKey('source-3', 2);

  assert.equal(shouldShowSourceChangeNotice(true, firstKey, null), true);
  const dismissed = reducePrintComposerUiState(INITIAL_PRINT_COMPOSER_UI_STATE, {
    type: 'dismiss-source-change',
    key: firstKey,
  });
  assert.equal(
    shouldShowSourceChangeNotice(true, firstKey, dismissed.dismissedSourceChangeKey),
    false,
  );
  assert.equal(
    shouldShowSourceChangeNotice(true, nextKey, dismissed.dismissedSourceChangeKey),
    true,
  );

  const blocksOpen = reducePrintComposerUiState(dismissed, {
    type: 'toggle-blocks-drawer',
  });
  assert.equal(blocksOpen.blocksDrawerOpen, true);
  assert.equal(blocksOpen.formattingDrawerOpen, false);
  const formattingOpen = reducePrintComposerUiState(blocksOpen, {
    type: 'toggle-formatting-drawer',
  });
  assert.equal(formattingOpen.blocksDrawerOpen, false);
  assert.equal(formattingOpen.formattingDrawerOpen, true);
  const closed = reducePrintComposerUiState(formattingOpen, {
    type: 'close-drawers',
  });
  assert.equal(closed.blocksDrawerOpen, false);
  assert.equal(closed.formattingDrawerOpen, false);
  assert.equal(closed.dismissedSourceChangeKey, firstKey);
  assert.equal(await createPrintDraftHash(draft), originalHash);
  assert.deepEqual(draft, printDraft());
});

test('Print Composer exposes accessible compact drawers without dropping controls', () => {
  const composer = source('../src/print/PrintComposer.tsx');
  const editor = source('../src/print/PrintComposerEditor.tsx');
  const css = source('../src/styles/index.css');

  assert.match(composer, /aria-label="Dismiss source-change notice"/u);
  assert.match(composer, /type: 'dismiss-source-change'/u);
  assert.match(composer, /Saved Print PDF replaced\./u);
  assert.match(composer, /aria-label="Dismiss action notification"/u);
  assert.match(
    composer,
    /<details className="print-composer-more-actions">\s*<summary>More<\/summary>/u,
  );
  assert.match(composer, /replaceRenderedPrintPdf\(artifact\)/u);
  assert.match(composer, /setRenderedPrintPdf\(persistedArtifact\)/u);
  assert.doesNotMatch(composer, /setRenderedPrintPdfState\('current'\)/u);
  assert.match(
    composer,
    /resolveStoredRenderedPrintPdfForDownload[\s\S]*URL\.createObjectURL\(persistedArtifact\.blob\)/u,
  );
  assert.match(
    composer,
    /print-source-change-banner[\s\S]*print-composer-notification-region/u,
  );
  assert.match(
    composer,
    /Print-source formatting\/order has changed since this draft was created\./u,
  );
  assert.match(editor, /aria-controls="print-blocks-drawer"/u);
  assert.match(editor, /aria-controls="print-formatting-drawer"/u);
  assert.match(editor, /aria-label="Close Blocks drawer"/u);
  assert.match(editor, /aria-label="Close Formatting drawer"/u);
  assert.match(editor, /event\.key !== 'Escape'/u);
  assert.match(editor, /updateBlocks\(editor\.getEditorState\(\)\)/u);
  assert.match(editor, /editor\.registerUpdateListener/u);
  for (const control of [
    'Font family',
    'Font size',
    'Paragraph style',
    'Line spacing',
    'Bullets',
    'Numbering',
    'Insert table',
    'Add row',
    'Remove row',
    'Add column',
    'Remove column',
    'Add text',
    'Add heading',
    'Add page break',
  ]) {
    assert.match(editor, new RegExp(control, 'u'));
  }
  assert.match(css, /\.print-block-manager\s*\{[\s\S]*?position: absolute/u);
  assert.match(css, /\.print-formatting-drawer\s*\{[\s\S]*?position: absolute/u);
  assert.match(
    css,
    /\.print-composer-more-actions\s*\{[\s\S]*?position: relative[\s\S]*?margin-left: auto/u,
  );
  assert.match(
    css,
    /\.print-composer-more-actions > div\s*\{[\s\S]*?position: absolute[\s\S]*?right: 0[\s\S]*?max-width: min\(320px, calc\(100vw - 24px\)\)/u,
  );
  assert.match(
    css,
    /\.print-composer-notification-region\s*\{[\s\S]*?display: flex[\s\S]*?flex: 0 0 auto/u,
  );
  assert.match(
    css,
    /\.print-composer-presets\s*\{[\s\S]*?flex: 1 1 360px[\s\S]*?margin-right: auto/u,
  );
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.print-formatting-drawer/u);
});

function printDraft(overrides: Partial<PrintDraftRecord> = {}): PrintDraftRecord {
  return {
    draftSchemaVersion: PRINT_DRAFT_SCHEMA_VERSION,
    documentId: 'doc-a',
    sourceFingerprint: 'source-1',
    sourceModelVersion: 2,
    editorStateJson: '{"root":{"children":[]}}',
    contentMode: 'notes-and-glossary',
    baseTemplateId: 'normal',
    templateVersion: 1,
    overrides: {},
    createdAt: 1,
    updatedAt: 1,
    lastSavedAt: 1,
    pendingAdditions: [
      {
        id: 'addition-1',
        kind: 'custom',
        label: 'Manual',
        content: 'Keep me',
        createdAt: 1,
      },
    ],
    ...overrides,
  };
}

function renderedDescriptor(renderedFromDraftHash: string): RenderedPrintPdfDescriptor {
  return {
    kind: 'rendered-print-pdf',
    documentId: 'doc-a',
    fileName: 'Paper - Print.pdf',
    mimeType: 'application/pdf',
    size: 123,
    sha256: 'b'.repeat(64),
    renderedFromDraftHash,
    createdAt: 1,
  };
}

function cloneRenderedPrintPdf(
  artifact: StoredRenderedPrintPdf,
): StoredRenderedPrintPdf {
  return {
    ...artifact,
    blob: new Blob([artifact.blob], { type: artifact.mimeType }),
  };
}

function restoreGlobalProperty(
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

async function syncEntity(
  kind: SyncEntityRecord['kind'],
  id: string,
  documentId: string | undefined,
  value: unknown,
): Promise<SyncEntityRecord> {
  return {
    key: createSyncEntityKey(kind, id, documentId),
    kind,
    id,
    ...(documentId ? { documentId } : {}),
    value,
    version: {
      updatedAt: 1,
      deviceId: 'device-a',
      hash: await sha256Hex(stableStringify(value)),
    },
  };
}

function syncSnapshot(entities: SyncEntityRecord[]): SyncSnapshot {
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: 1,
    generatedBy: 'device-a',
    entities,
    tombstones: [],
    pdfs: [],
  };
}

async function paperManifest() {
  return createPaperManifestGeneration(
    {
      app: '39Note',
      syncLayoutVersion: PAPER_PACKAGE_LAYOUT_VERSION,
      paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
      payloadStorage: PAPER_PAYLOAD_STORAGE,
      manifestStorage: PAPER_MANIFEST_STORAGE,
      documentId: 'doc-a',
      paperFolderId: 'folder-a',
      dataFolderId: 'data-a',
      displayName: 'Paper',
      deleted: false,
      writer: { deviceId: 'device-a' },
      state: { fileId: 'state-a', sha256: 'a'.repeat(64) },
      productivity: { fileId: 'productivity-a', sha256: 'b'.repeat(64) },
      conflictJournal: { fileId: 'conflicts-a', sha256: 'c'.repeat(64) },
      conflictIds: [],
    },
    { createdAt: 1, createdBy: 'device-a', parents: [] },
  );
}
