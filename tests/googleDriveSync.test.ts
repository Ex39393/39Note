import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  combineCloudPayloads,
  createCloudManifestGeneration,
  encodeCloudPayload,
  IMMUTABLE_MANIFEST_STORAGE,
  isImmutableCloudManifest,
  parseCloudManifest,
  parseCloudPayload,
  partitionSnapshot,
  replacePayloadForContext,
  verifyCloudManifestGeneration,
  type CloudSyncManifest,
  type ImmutableCloudSyncManifest,
} from '../src/sync/cloudFormat.ts';
import { shouldWarnBeforeUnload } from '../src/sync/lifecycle.ts';
import {
  DriveAuthorizationError,
  DriveClient,
  DriveNetworkError,
  DriveRequestError,
  type DriveFileMetadata,
  type DriveRequestContext,
  type DriveRequestTelemetryEvent,
} from '../src/sync/driveClient.ts';
import {
  formatDriveOperationDiagnostic,
  summarizeDriveOperationTelemetry,
} from '../src/sync/driveOperationTelemetry.ts';
import { planPaperChangeDiscovery } from '../src/sync/paperIncrementalDiscovery.ts';
import {
  DriveRootUnavailableError,
  GoogleDrivePayloadIntegrityError,
  GoogleDriveSyncRepository,
  MultipleDriveRootsError,
  RemoteManifestChangedError,
} from '../src/sync/driveRepository.ts';
import { sha256Hex, stableStringify } from '../src/sync/hash.ts';
import {
  GoogleReauthorizationRequiredError,
  PersistentGoogleAuthSession,
  SyncBackendUnavailableError,
  validateSyncAuthUrl,
} from '../src/sync/googleIdentity.ts';
import { mergeSyncSnapshots } from '../src/sync/merge.ts';
import type { SyncViewState } from '../src/sync/coordinator.ts';
import { serializeSafeAiConfiguration } from '../src/sync/safeAiSettings.ts';
import {
  assertNoSecretsInSyncPayload,
  containsSecretMarker,
} from '../src/sync/secrets.ts';
import {
  SYNC_DATABASE_NAME,
  SYNC_DATABASE_VERSION,
  SYNC_SCHEMA_VERSION,
  createSyncEntityKey,
  type SyncEntityRecord,
  type SyncConflict,
  type SyncDeviceState,
  type LocalSyncPdf,
  type SyncProgress,
  type SyncSnapshot,
} from '../src/sync/types.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const PENDING_EXCHANGE_STORAGE_KEY = '39note.google-drive.pending-exchange';

interface MockOAuthBrowser {
  location: { href: string; hash: string };
  storage: Storage;
}

async function withMockOAuthBrowser<T>(
  options: {
    fragment: string;
    pendingExchange?: string | Record<string, unknown>;
    fetcher: typeof fetch;
  },
  run: (browser: MockOAuthBrowser) => Promise<T>,
): Promise<T> {
  const descriptors = new Map<string, PropertyDescriptor | undefined>(
    ['window', 'history', 'sessionStorage', 'fetch'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const values = new Map<string, string>();
  if (options.pendingExchange !== undefined) {
    values.set(
      PENDING_EXCHANGE_STORAGE_KEY,
      typeof options.pendingExchange === 'string'
        ? options.pendingExchange
        : JSON.stringify(options.pendingExchange),
    );
  }
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
  const location = {
    href: `http://127.0.0.1:5173/${options.fragment}`,
    hash: options.fragment,
  };
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: { location: { ...location, assign() {} } },
    },
    history: {
      configurable: true,
      value: {
        state: null,
        replaceState(_state: unknown, _unused: string, url: string) {
          const next = new URL(url);
          location.href = next.toString();
          location.hash = next.hash;
          Object.assign(
            (globalThis as { window: { location: object } }).window.location,
            location,
          );
        },
      },
    },
    sessionStorage: { configurable: true, value: storage },
    fetch: { configurable: true, writable: true, value: options.fetcher },
  });

  try {
    return await run({ location, storage });
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function entity(
  kind: SyncEntityRecord['kind'],
  id: string,
  value: unknown,
  updatedAt: number,
  deviceId: string,
  hash: string,
  documentId?: string,
): SyncEntityRecord {
  return {
    key: createSyncEntityKey(kind, id, documentId),
    kind,
    id,
    ...(documentId ? { documentId } : {}),
    value,
    version: { updatedAt, deviceId, hash: hash.padEnd(64, '0').slice(0, 64) },
  };
}

function snapshot(
  entities: SyncEntityRecord[],
  generatedBy = 'device-a',
): SyncSnapshot {
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: 1,
    generatedBy,
    entities,
    tombstones: [],
    pdfs: [],
  };
}

function validDocumentEntity(documentId = 'doc-1'): SyncEntityRecord {
  return entity(
    'document',
    documentId,
    {
      documentId,
      documentName: 'paper.pdf',
      originalFileName: 'paper.pdf',
      displayTitle: 'Paper',
      nextNoteNumber: 1,
      collectionIds: [],
      tagIds: [],
      isPinned: false,
    },
    1,
    'device-a',
    'd',
  );
}

function deviceState(): SyncDeviceState {
  return {
    id: 'device',
    deviceId: 'device-clean',
    autoSync: true,
    dirty: false,
    dirtyGeneration: 0,
    entityVersions: {},
    baselineHashes: {},
    tombstones: [],
    conflicts: [],
    pdfFingerprints: {},
    driveFiles: { fileIds: {} },
  };
}

interface MemoryDriveFile extends DriveFileMetadata {
  content?: Blob;
}

interface MemoryDriveWrite {
  name: string;
  content: Blob;
  metadata?: { parents?: string[]; appProperties?: Record<string, string> };
}

interface MemoryDriveMutation {
  method: 'POST' | 'PATCH';
  operation: 'create-folder' | 'create-file' | 'update-metadata' | 'trash-for-reset';
  fileId: string;
  name: string;
  role?: string;
}

class InMemoryDrive {
  readonly files = new Map<string, MemoryDriveFile>();
  readonly operations: string[] = [];
  readonly mutations: MemoryDriveMutation[] = [];
  readonly listQueries: string[] = [];
  readonly blobDownloadCount = new Map<string, number>();
  readonly textDownloadCount = new Map<string, number>();
  readonly blobDownloadSequences = new Map<string, Blob[]>();
  readonly manifestListSnapshots: string[][] = [];
  beforeUpload?: (write: MemoryDriveWrite) => void | Promise<void>;
  beforeTrash?: (file: DriveFileMetadata) => void | Promise<void>;
  beforeList?: (query: string) => void | Promise<void>;
  afterDownloadText?: (fileId: string, text: string) => void | Promise<void>;
  afterCreateFolder?: (folder: DriveFileMetadata) => void | Promise<void>;
  duplicateManifestListResults = false;

  private nextId = 1;
  private nextVersion = 1;

  asClient(): DriveClient {
    return this as unknown as DriveClient;
  }

  async listFiles(query: string): Promise<DriveFileMetadata[]> {
    this.listQueries.push(query);
    await this.beforeList?.(query);
    const parent = query.match(/^'([^']+)' in parents/u)?.[1];
    const name = query.match(/name='([^']+)'/u)?.[1];
    const mimeType = query.match(/mimeType='([^']+)'/u)?.[1];
    const requiresAppRoot =
      query.includes('appProperties has') && query.includes("role' and value='root");
    const requiresManifestGeneration =
      query.includes('appProperties has') &&
      query.includes("role' and value='manifest-generation");
    let candidates = [...this.files.values()];
    if (requiresManifestGeneration && this.manifestListSnapshots.length > 0) {
      candidates = this.manifestListSnapshots
        .shift()!
        .flatMap((fileId) => (this.files.get(fileId) ? [this.files.get(fileId)!] : []));
    }
    const listed = candidates
      .filter((file) => !file.trashed)
      .filter((file) => !parent || file.parents?.includes(parent))
      .filter((file) => !name || file.name === name)
      .filter((file) => !mimeType || file.mimeType === mimeType)
      .filter(
        (file) =>
          !requiresAppRoot ||
          (file.appProperties?.application === '39Note' &&
            file.appProperties.role === 'root'),
      )
      .filter(
        (file) =>
          !requiresManifestGeneration ||
          (file.appProperties?.application === '39Note' &&
            file.appProperties.role === 'manifest-generation'),
      )
      .map((file) => this.metadata(file));
    return requiresManifestGeneration && this.duplicateManifestListResults
      ? listed.flatMap((file) => [file, structuredClone(file)])
      : listed;
  }

  async getMetadata(fileId: string): Promise<DriveFileMetadata> {
    const file = this.files.get(fileId);
    if (!file) throw new DriveRequestError('Missing in-memory Drive item.', 404);
    return this.metadata(file);
  }

  async createFolder(
    name: string,
    parentId: string | null,
    appProperties: Record<string, string>,
  ): Promise<DriveFileMetadata> {
    const file = this.createFile({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties,
    });
    this.operations.push(`folder:${name}`);
    const metadata = this.metadata(file);
    this.mutations.push({
      method: 'POST',
      operation: 'create-folder',
      fileId: file.id,
      name,
      role: appProperties.role,
    });
    await this.afterCreateFolder?.(metadata);
    return metadata;
  }

  async updateMetadata(
    fileId: string,
    metadata: { appProperties?: Record<string, string> },
  ): Promise<DriveFileMetadata> {
    const file = this.requireFile(fileId);
    if (metadata.appProperties) file.appProperties = { ...metadata.appProperties };
    this.bump(file);
    this.operations.push(`metadata:${file.name}`);
    this.mutations.push({
      method: 'PATCH',
      operation: 'update-metadata',
      fileId,
      name: file.name,
      role: file.appProperties?.role,
    });
    return this.metadata(file);
  }

  async trashManagedFileForReset(fileId: string): Promise<DriveFileMetadata> {
    const file = this.requireFile(fileId);
    await this.beforeTrash?.(this.metadata(file));
    file.trashed = true;
    this.bump(file);
    this.operations.push(`trash:${file.name}`);
    this.mutations.push({
      method: 'PATCH',
      operation: 'trash-for-reset',
      fileId,
      name: file.name,
      role: file.appProperties?.role,
    });
    return this.metadata(file);
  }

  async uploadFile(
    name: string,
    content: Blob,
    metadata: { parents?: string[]; appProperties?: Record<string, string> },
  ): Promise<DriveFileMetadata> {
    const write = { name, content, metadata };
    this.operations.push(`upload:start:${name}`);
    await this.beforeUpload?.(write);
    const file = this.createFile({
      name,
      mimeType: content.type || 'application/octet-stream',
      content,
      ...(metadata.parents ? { parents: [...metadata.parents] } : {}),
      ...(metadata.appProperties
        ? { appProperties: { ...metadata.appProperties } }
        : {}),
    });
    this.operations.push(`upload:commit:${name}`);
    this.mutations.push({
      method: 'POST',
      operation: 'create-file',
      fileId: file.id,
      name,
      role: metadata.appProperties?.role,
    });
    return this.metadata(file);
  }

  async downloadBlob(fileId: string): Promise<Blob> {
    this.blobDownloadCount.set(fileId, (this.blobDownloadCount.get(fileId) ?? 0) + 1);
    const sequence = this.blobDownloadSequences.get(fileId);
    if (sequence?.length) return sequence.shift() as Blob;
    const content = this.requireFile(fileId).content;
    if (!content)
      throw new Error('The in-memory Drive item has no downloadable bytes.');
    return content;
  }

  async downloadText(fileId: string): Promise<string> {
    this.textDownloadCount.set(fileId, (this.textDownloadCount.get(fileId) ?? 0) + 1);
    const text = await (await this.downloadBlobWithoutCounting(fileId)).text();
    await this.afterDownloadText?.(fileId, text);
    return text;
  }

  findByName(name: string): MemoryDriveFile {
    const matches = [...this.files.values()].filter(
      (file) => !file.trashed && file.name === name,
    );
    assert.equal(matches.length, 1, `Expected one in-memory Drive item named ${name}.`);
    return matches[0];
  }

  findByRole(role: string): MemoryDriveFile[] {
    return [...this.files.values()].filter(
      (file) => !file.trashed && file.appProperties?.role === role,
    );
  }

  manifestGenerations(): MemoryDriveFile[] {
    return this.findByRole('manifest-generation').sort((first, second) =>
      first.id.localeCompare(second.id),
    );
  }

  async readManifestGeneration(
    file: DriveFileMetadata | string,
  ): Promise<ReturnType<typeof parseCloudManifest>> {
    return parseCloudManifest(
      await this.downloadText(typeof file === 'string' ? file : file.id),
    );
  }

  queueManifestListSnapshot(files: readonly (DriveFileMetadata | string)[]): void {
    this.manifestListSnapshots.push(
      files.map((file) => (typeof file === 'string' ? file : file.id)),
    );
  }

  setContent(fileId: string, content: Blob): void {
    this.requireFile(fileId).content = content;
  }

  async readManifest(): Promise<ReturnType<typeof parseCloudManifest>> {
    const generations = this.manifestGenerations();
    if (generations.length > 0) {
      assert.equal(
        generations.length,
        1,
        'Expected exactly one immutable manifest generation.',
      );
      return this.readManifestGeneration(generations[0]);
    }
    return this.readManifestGeneration(this.findByName('39note-manifest.json'));
  }

  private async downloadBlobWithoutCounting(fileId: string): Promise<Blob> {
    const content = this.requireFile(fileId).content;
    if (!content)
      throw new Error('The in-memory Drive item has no downloadable bytes.');
    return content;
  }

  private createFile(value: Omit<MemoryDriveFile, 'id' | 'version'>): MemoryDriveFile {
    const version = String(this.nextVersion++);
    const file: MemoryDriveFile = {
      id: `memory-${this.nextId++}`,
      version,
      ...value,
    };
    this.files.set(file.id, file);
    return file;
  }

  private bump(file: MemoryDriveFile): void {
    const version = String(this.nextVersion++);
    file.version = version;
  }

  private requireFile(fileId: string): MemoryDriveFile {
    const file = this.files.get(fileId);
    if (!file) throw new DriveRequestError('Missing in-memory Drive item.', 404);
    return file;
  }

  private metadata(file: MemoryDriveFile): DriveFileMetadata {
    const metadata = { ...file };
    Reflect.deleteProperty(metadata, 'content');
    return structuredClone(metadata);
  }
}

function studySnapshot(
  noteContent: string,
  updatedAt: number,
  deviceId: string,
): SyncSnapshot {
  return snapshot(
    [
      entity('document', 'doc-1', { displayTitle: 'Study' }, 1, 'device-a', 'd'),
      entity(
        'note',
        'note-1',
        { content: noteContent },
        updatedAt,
        deviceId,
        updatedAt.toString(16),
        'doc-1',
      ),
    ],
    deviceId,
  );
}

function orderedSnapshot(value: SyncSnapshot): SyncSnapshot {
  return {
    ...value,
    entities: [...value.entities].sort((first, second) =>
      first.key.localeCompare(second.key),
    ),
    tombstones: [...value.tombstones].sort((first, second) =>
      first.key.localeCompare(second.key),
    ),
    pdfs: [...value.pdfs].sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    ),
  };
}

async function seedMemoryDrive(
  drive: InMemoryDrive,
  value: SyncSnapshot,
  localPdfs: readonly LocalSyncPdf[] = [],
): Promise<{ repository: GoogleDriveSyncRepository; state: SyncDeviceState }> {
  const state = deviceState();
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  const pushed = await repository.push(
    value,
    localPdfs,
    state,
    new AbortController().signal,
  );
  state.remoteManifestVersion = pushed.manifestVersion;
  state.remoteSnapshot = pushed.snapshot;
  return { repository, state };
}

async function exactEntity(
  kind: SyncEntityRecord['kind'],
  id: string,
  value: unknown,
  updatedAt: number,
  deviceId: string,
  documentId?: string,
): Promise<SyncEntityRecord> {
  return entity(
    kind,
    id,
    value,
    updatedAt,
    deviceId,
    await sha256Hex(stableStringify(value)),
    documentId,
  );
}

async function comprehensiveLegacyFixture(): Promise<{
  snapshot: SyncSnapshot;
  pdf: LocalSyncPdf;
  conflicts: SyncDeviceState['conflicts'];
}> {
  const deviceId = 'legacy-device-a';
  const documentId = 'legacy-doc-1';
  const rects = [{ x: 0.12, y: 0.24, width: 0.31, height: 0.04 }];
  const values: Array<
    [SyncEntityRecord['kind'], string, unknown, number, string | undefined]
  > = [
    [
      'document',
      documentId,
      {
        schemaVersion: 7,
        documentId,
        documentName: 'mueller-oppenheimer.pdf',
        originalFileName: 'mueller-oppenheimer.pdf',
        displayTitle: 'The Pen Is Mightier Than the Keyboard',
        nextNoteNumber: 3,
        collectionIds: ['collection-research'],
        tagIds: ['tag-learning'],
        isPinned: true,
        pinnedAt: 110,
        lastReadAt: 120,
      },
      120,
      undefined,
    ],
    [
      'annotation',
      'highlight-1',
      {
        id: 'highlight-1',
        type: 'highlight',
        pageNumber: 2,
        text: 'There was no significant difference',
        rects,
        color: 'yellow',
        createdAt: 130,
        updatedAt: 131,
      },
      131,
      documentId,
    ],
    [
      'annotation',
      'underline-1',
      {
        id: 'underline-1',
        type: 'underline',
        pageNumber: 3,
        text: 'condition',
        rects,
        color: 'blue',
        createdAt: 132,
        updatedAt: 133,
      },
      133,
      documentId,
    ],
    [
      'note-anchor',
      'anchor-1',
      {
        id: 'anchor-1',
        type: 'note-anchor',
        pageNumber: 4,
        text: 'note-taking',
        rects,
        startOffset: 10,
        endOffset: 21,
        createdAt: 134,
        updatedAt: 135,
      },
      135,
      documentId,
    ],
    [
      'note',
      'note-1',
      {
        id: 'note-1',
        annotationId: 'anchor-1',
        pageNumber: 4,
        displayNumber: '2',
        selectedText: 'note-taking',
        content: 'Editable legacy note',
        createdAt: 136,
        updatedAt: 137,
      },
      137,
      documentId,
    ],
    [
      'glossary',
      'glossary-1',
      {
        glossaryEntryId: 'glossary-1',
        documentId,
        displayedWord: 'condition',
        normalizedLookupWord: 'condition',
        definition: 'A state or circumstance.',
        pageNumber: 3,
        sourceRects: rects,
        startOffset: 2,
        endOffset: 11,
        createdAt: 138,
        source: {
          provider: 'wordnet',
          dataset: 'Princeton WordNet',
          version: '3.1',
          license: 'Princeton WordNet License',
          sourceUrl: 'https://wordnet.princeton.edu/',
          partOfSpeech: 'noun',
        },
        markerAnnotationId: 'glossary-marker-1',
      },
      138,
      documentId,
    ],
    [
      'reading-position',
      documentId,
      {
        pageNumber: 6,
        pageOffsetRatio: 0.42,
        zoomMode: 'fit-width',
        zoomPercent: 1.25,
        updatedAt: 139,
      },
      139,
      documentId,
    ],
    [
      'collection',
      'collection-research',
      {
        id: 'collection-research',
        name: 'Research',
        normalizedName: 'research',
        createdAt: 140,
        updatedAt: 141,
      },
      141,
      undefined,
    ],
    [
      'tag',
      'tag-learning',
      {
        id: 'tag-learning',
        name: 'Learning',
        normalizedName: 'learning',
        createdAt: 142,
        updatedAt: 143,
      },
      143,
      undefined,
    ],
    [
      'print-draft',
      documentId,
      {
        documentId,
        sourceFingerprint: 'legacy-source-fingerprint',
        sourceModelVersion: 1,
        editorStateJson: '{"root":{"children":[]}}',
        layout: 'standard',
        createdAt: 144,
        updatedAt: 145,
        lastSavedAt: 145,
        pendingAdditions: [
          {
            id: 'addition-1',
            kind: 'custom',
            label: 'Legacy addition',
            content: 'Preserve this draft addition.',
            createdAt: 144,
          },
        ],
      },
      145,
      documentId,
    ],
    [
      'ai-conversation',
      'conversation-1',
      {
        id: 'conversation-1',
        documentId,
        title: 'Legacy study chat',
        promptProfileId: 'profile-legacy',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Summarize the finding.',
            createdAt: 146,
            status: 'complete',
            pages: [2],
            contextCharacters: 128,
          },
          {
            id: 'message-2',
            role: 'assistant',
            content: 'Longhand note-taking improved conceptual recall.',
            createdAt: 147,
            status: 'complete',
          },
        ],
        createdAt: 146,
        updatedAt: 147,
      },
      147,
      documentId,
    ],
    [
      'ai-configuration',
      'configuration',
      serializeSafeAiConfiguration({
        providerId: 'openai',
        protocol: 'openai-chat-completions',
        providerLabel: 'OpenAI',
        baseUrl: 'https://api.openai.com',
        endpointPath: '/v1/chat/completions',
        model: 'gpt-5-mini',
        temperature: 0.2,
        maximumOutputTokens: 1200,
        contextCharacterBudget: 12000,
        customHeaders: {},
        rememberApiKey: false,
        qwenRegion: 'international',
        qwenWorkspaceId: '',
      }),
      148,
      undefined,
    ],
    [
      'prompt-profile',
      'profile-legacy',
      {
        id: 'profile-legacy',
        name: 'Legacy study prompt',
        prompt: 'Explain the selected evidence clearly.',
        builtIn: false,
      },
      149,
      undefined,
    ],
    ['default-prompt', 'default', 'profile-legacy', 150, undefined],
  ];
  const entities = await Promise.all(
    values.map(([kind, id, value, updatedAt, documentIdValue]) =>
      exactEntity(kind, id, value, updatedAt, deviceId, documentIdValue),
    ),
  );
  entities.sort((first, second) =>
    first.key < second.key ? -1 : first.key > second.key ? 1 : 0,
  );
  const deletedKey = createSyncEntityKey('note', 'deleted-note', documentId);
  const pdfBlob = new Blob(['%PDF-1.4\nlegacy fixture\n%%EOF'], {
    type: 'application/pdf',
  });
  const pdf: LocalSyncPdf = {
    documentId,
    fileName: 'mueller-oppenheimer.pdf',
    mimeType: 'application/pdf',
    size: pdfBlob.size,
    lastModified: 151,
    storedAt: 152,
    sha256: await sha256Hex(pdfBlob),
    blob: pdfBlob,
  };
  const note = entities.find((candidate) => candidate.kind === 'note');
  assert.ok(note);
  return {
    snapshot: {
      app: '39Note',
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      generatedAt: 153,
      generatedBy: deviceId,
      entities,
      tombstones: [
        {
          key: deletedKey,
          kind: 'note',
          id: 'deleted-note',
          documentId,
          deletedAt: 154,
          deviceId,
        },
      ],
      pdfs: [
        {
          documentId: pdf.documentId,
          fileName: pdf.fileName,
          mimeType: pdf.mimeType,
          size: pdf.size,
          lastModified: pdf.lastModified,
          storedAt: pdf.storedAt,
          sha256: pdf.sha256,
        },
      ],
    },
    pdf,
    conflicts: [
      {
        id: 'legacy-conflict-1',
        entityKey: note.key,
        entityKind: 'note',
        documentId,
        detectedAt: 155,
        winningVersion: note.version,
        alternateVersion: {
          updatedAt: 136,
          deviceId: 'legacy-device-b',
          hash: 'f'.repeat(64),
        },
        winningValue: note.value,
        alternateValue: { ...(note.value as object), content: 'Alternate legacy note' },
      },
    ],
  };
}

async function seedExactLegacyDrive(
  drive: InMemoryDrive,
  value: SyncSnapshot,
  pdf: LocalSyncPdf,
): Promise<{
  manifest: ReturnType<typeof parseCloudManifest>;
  manifestFile: DriveFileMetadata;
  legacyFileIds: string[];
}> {
  const root = await drive.createFolder('39Note', null, {
    application: '39Note',
    syncSchema: '1',
    role: 'root',
  });
  const documentsFolder = await drive.createFolder('documents', root.id, {
    application: '39Note',
    syncSchema: '1',
    role: 'documents',
  });
  const documentId = value.pdfs[0].documentId;
  const documentFolder = await drive.createFolder(
    `document-${documentId}`,
    documentsFolder.id,
    {
      application: '39Note',
      syncSchema: '1',
      role: 'document',
      documentId,
    },
  );
  await drive.uploadFile(
    'README.txt',
    new Blob(
      [
        '39Note Google Drive Sync\n\n',
        'This visible folder contains versioned, app-created sync data and original PDF files.\n',
        'Edit your notes in 39Note, not directly in these JSON files. Malformed or newer-version data is rejected.\n',
        'AI API keys, Google OAuth tokens, passwords, client secrets, and custom authentication headers are never included.\n',
        'Sync schema version: 1\n',
      ],
      { type: 'text/plain' },
    ),
    {
      parents: [root.id],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'readme',
      },
    },
  );
  const partitions = partitionSnapshot(value);
  const uploadLegacyPayload = async (
    name: string,
    parentId: string,
    role: string,
    payloadValue: ReturnType<typeof partitionSnapshot>['library'],
  ) => {
    const encoded = await encodeCloudPayload(payloadValue);
    const file = await drive.uploadFile(
      name,
      new Blob([encoded.text], { type: 'application/json' }),
      {
        parents: [parentId],
        appProperties: { application: '39Note', syncSchema: '1', role },
      },
    );
    return { file, reference: { fileId: file.id, sha256: encoded.sha256 } };
  };
  const library = await uploadLegacyPayload(
    'library.json',
    root.id,
    'library',
    partitions.library,
  );
  const aiSettings = await uploadLegacyPayload(
    'ai-settings.json',
    root.id,
    'ai-settings',
    partitions.aiSettings,
  );
  const documentPartition = partitions.documents.get(documentId);
  assert.ok(documentPartition);
  const state = await uploadLegacyPayload(
    'state.json',
    documentFolder.id,
    'state',
    documentPartition.state,
  );
  const productivity = await uploadLegacyPayload(
    'productivity.json',
    documentFolder.id,
    'productivity',
    documentPartition.productivity,
  );
  const pdfFile = await drive.uploadFile('original.pdf', pdf.blob, {
    parents: [documentFolder.id],
    appProperties: {
      application: '39Note',
      syncSchema: '1',
      role: 'original-pdf',
      documentId,
      sha256: pdf.sha256,
    },
  });
  const manifest = {
    app: '39Note' as const,
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: value.generatedAt,
    generatedBy: value.generatedBy,
    library: library.reference,
    aiSettings: aiSettings.reference,
    documents: [
      {
        documentId,
        folderId: documentFolder.id,
        state: state.reference,
        productivity: productivity.reference,
        pdf: { ...value.pdfs[0], fileId: pdfFile.id },
      },
    ],
  };
  const manifestFile = await drive.uploadFile(
    '39note-manifest.json',
    new Blob([stableStringify(manifest)], { type: 'application/json' }),
    {
      parents: [root.id],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'manifest',
      },
    },
  );
  return {
    manifest: parseCloudManifest(stableStringify(manifest)),
    manifestFile,
    legacyFileIds: [
      library.file.id,
      aiSettings.file.id,
      state.file.id,
      productivity.file.id,
      pdfFile.id,
    ],
  };
}

async function expectIntegrityFailure(
  repository: GoogleDriveSyncRepository,
  state: SyncDeviceState,
): Promise<GoogleDrivePayloadIntegrityError> {
  try {
    await repository.pull(state, new AbortController().signal);
  } catch (error) {
    assert.ok(error instanceof GoogleDrivePayloadIntegrityError);
    return error;
  }
  assert.fail('Expected Google Drive payload integrity verification to fail.');
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function createMemoryStateGeneration(
  drive: InMemoryDrive,
  manifest: ReturnType<typeof parseCloudManifest>,
  value: SyncSnapshot,
): Promise<{
  encoded: Awaited<ReturnType<typeof encodeCloudPayload>>;
  file: DriveFileMetadata;
  manifest: ReturnType<typeof parseCloudManifest>;
}> {
  const document = manifest.documents.find((item) => item.documentId === 'doc-1');
  const payload = partitionSnapshot(value).documents.get('doc-1')?.state;
  assert.ok(document);
  assert.ok(payload);
  const encoded = await encodeCloudPayload(payload);
  const file = await drive.uploadFile(
    `state-${encoded.sha256.slice(0, 16)}.json`,
    new Blob([encoded.text], { type: 'application/json' }),
    {
      parents: [document.folderId],
      appProperties: {
        application: '39Note',
        role: 'state',
        sha256: encoded.sha256,
      },
    },
  );
  return {
    encoded,
    file,
    manifest: {
      ...manifest,
      generatedAt: value.generatedAt,
      generatedBy: value.generatedBy,
      documents: manifest.documents.map((item) =>
        item.documentId === 'doc-1'
          ? { ...item, state: { fileId: file.id, sha256: encoded.sha256 } }
          : item,
      ),
    },
  };
}

async function uploadManifestGeneration(
  drive: InMemoryDrive,
  manifestBase: CloudSyncManifest,
  options: {
    createdAt: number;
    createdBy: string;
    parents?: readonly string[];
    legacySources?: readonly string[];
  },
): Promise<{
  file: DriveFileMetadata;
  manifest: ImmutableCloudSyncManifest;
}> {
  const manifest = await createCloudManifestGeneration(manifestBase, {
    createdAt: options.createdAt,
    createdBy: options.createdBy,
    parents: options.parents ?? [],
    legacySources: options.legacySources ?? [],
  });
  const file = await drive.uploadFile(
    `39note-manifest-v1-${manifest.generation.id}.json`,
    new Blob([stableStringify(manifest)], { type: 'application/json' }),
    {
      parents: [drive.findByRole('root')[0].id],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'manifest-generation',
        manifestStorage: IMMUTABLE_MANIFEST_STORAGE,
        generationId: manifest.generation.id,
      },
    },
  );
  return { file, manifest };
}

async function uploadStateBranch(
  drive: InMemoryDrive,
  parent: ImmutableCloudSyncManifest,
  value: SyncSnapshot,
): Promise<{
  file: DriveFileMetadata;
  manifest: ImmutableCloudSyncManifest;
}> {
  const generated = await createMemoryStateGeneration(drive, parent, value);
  return uploadManifestGeneration(drive, generated.manifest, {
    createdAt: value.generatedAt,
    createdBy: value.generatedBy,
    parents: [parent.generation.id],
    legacySources: parent.generation.legacySources,
  });
}

async function readManifestGenerations(
  drive: InMemoryDrive,
): Promise<Array<{ file: MemoryDriveFile; manifest: ImmutableCloudSyncManifest }>> {
  const generations = await Promise.all(
    drive.manifestGenerations().map(async (file) => ({
      file,
      manifest: await drive.readManifestGeneration(file),
    })),
  );
  for (const generation of generations) {
    assert.ok(isImmutableCloudManifest(generation.manifest));
  }
  return generations as Array<{
    file: MemoryDriveFile;
    manifest: ImmutableCloudSyncManifest;
  }>;
}

function logicalManifestHeads(
  generations: readonly { manifest: ImmutableCloudSyncManifest }[],
): ImmutableCloudSyncManifest[] {
  const logical = new Map(
    generations.map((generation) => [generation.manifest.generation.id, generation]),
  );
  const parentIds = new Set(
    [...logical.values()].flatMap(
      (generation) => generation.manifest.generation.parents,
    ),
  );
  return [...logical.values()]
    .filter((generation) => !parentIds.has(generation.manifest.generation.id))
    .map((generation) => generation.manifest)
    .sort((first, second) => first.generation.id.localeCompare(second.generation.id));
}

function createTombstoneSnapshot(
  value: SyncSnapshot,
  entityKey: string,
  deletedAt: number,
  deviceId: string,
): SyncSnapshot {
  const deleted = value.entities.find((candidate) => candidate.key === entityKey);
  assert.ok(deleted);
  return {
    ...value,
    generatedAt: deletedAt,
    generatedBy: deviceId,
    entities: value.entities.filter((candidate) => candidate.key !== entityKey),
    tombstones: [
      ...value.tombstones,
      {
        key: deleted.key,
        kind: deleted.kind,
        id: deleted.id,
        ...(deleted.documentId ? { documentId: deleted.documentId } : {}),
        deletedAt,
        deviceId,
      },
    ],
  };
}

async function replaceImmutableStateWithValidAlternate(
  drive: InMemoryDrive,
  manifest: ImmutableCloudSyncManifest,
  alternate: SyncSnapshot,
): Promise<{
  expected: CloudSyncManifest['documents'][number]['state'];
  alternate: Awaited<ReturnType<typeof encodeCloudPayload>>;
}> {
  const document = manifest.documents.find((item) => item.documentId === 'doc-1');
  const payload = partitionSnapshot(alternate).documents.get('doc-1')?.state;
  assert.ok(document);
  assert.ok(payload);
  const encoded = await encodeCloudPayload(payload);
  drive.setContent(
    document.state.fileId,
    new Blob([encoded.text], { type: 'application/json' }),
  );
  return { expected: document.state, alternate: encoded };
}

async function writeExternalLegacyStateRevision(
  drive: InMemoryDrive,
  manifestFile: DriveFileMetadata,
  manifest: CloudSyncManifest,
  value: SyncSnapshot,
): Promise<{
  manifest: CloudSyncManifest;
  text: string;
  stateFile: DriveFileMetadata;
}> {
  const document = manifest.documents[0];
  assert.ok(document);
  const payload = partitionSnapshot(value).documents.get(document.documentId)?.state;
  assert.ok(payload);
  const encoded = await encodeCloudPayload(payload);
  const stateFile = await drive.uploadFile(
    `legacy-external-state-${encoded.sha256.slice(0, 16)}.json`,
    new Blob([encoded.text], { type: 'application/json' }),
    {
      parents: [document.folderId],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'state',
      },
    },
  );
  const next: CloudSyncManifest = {
    ...manifest,
    generatedAt: value.generatedAt,
    generatedBy: value.generatedBy,
    documents: manifest.documents.map((item) =>
      item.documentId === document.documentId
        ? {
            ...item,
            state: { fileId: stateFile.id, sha256: encoded.sha256 },
          }
        : item,
    ),
  };
  const text = stableStringify(next);
  drive.setContent(manifestFile.id, new Blob([text], { type: 'application/json' }));
  return { manifest: next, text, stateFile };
}

test('sync uses a separate versioned IndexedDB without changing the main schema', () => {
  assert.equal(SYNC_SCHEMA_VERSION, 1);
  assert.equal(SYNC_DATABASE_NAME, '39note-sync');
  assert.equal(SYNC_DATABASE_VERSION, 2);
  const persistence = source('../src/services/annotationPersistence.ts');
  assert.match(persistence, /const DATABASE_VERSION = 3/);
  assert.match(persistence, /PERSISTENCE_SCHEMA_VERSION = 8/);
});

test('concurrent coordinator initialization reuses one in-flight device-state load', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      setInterval() {
        return 1;
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    },
  });

  let loadCalls = 0;
  let releaseDeviceState!: (state: SyncDeviceState) => void;
  const delayedDeviceState = new Promise<SyncDeviceState>((resolve) => {
    releaseDeviceState = resolve;
  });
  let coordinator:
    | {
        destroy(): void;
        getSnapshot(): { connection: string };
        initialize(): Promise<void>;
      }
    | undefined;
  try {
    const module = (await server.ssrLoadModule(
      '/src/sync/coordinator.ts',
    )) as typeof import('../src/sync/coordinator.ts');
    coordinator = new module.GoogleDriveSyncCoordinator(async () => {
      loadCalls += 1;
      return delayedDeviceState;
    });
    const first = coordinator.initialize();
    const second = coordinator.initialize();
    assert.equal(first, second);
    assert.equal(loadCalls, 1);

    releaseDeviceState(deviceState());
    await Promise.all([first, second]);
    assert.equal(loadCalls, 1);
    assert.equal(coordinator.getSnapshot().connection, 'not-configured');
  } finally {
    coordinator?.destroy();
    await server.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument)
      Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('coordinator exposes truthful pending, syncing, success, and failure states', async (context) => {
  const storageHooksKey = '__39noteCoordinatorStorageHooks';
  const previousStorageHooks = Object.getOwnPropertyDescriptor(
    globalThis,
    storageHooksKey,
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const scheduledTimeouts: Array<() => void> = [];
  let savedStates: SyncDeviceState[] = [];
  Object.defineProperty(globalThis, storageHooksKey, {
    configurable: true,
    value: {
      async load() {
        return deviceState();
      },
      async save(state: SyncDeviceState) {
        savedStates.push(structuredClone(state));
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener() {},
      dispatchEvent() {
        return true;
      },
      removeEventListener() {},
      setInterval() {
        return 1;
      },
      setTimeout(callback: () => void) {
        scheduledTimeouts.push(callback);
        return scheduledTimeouts.length;
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });

  const { createServer } = await import('vite');
  const virtualStorageId = '\0virtual:coordinator-test-storage';
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        enforce: 'pre',
        name: 'coordinator-test-storage',
        resolveId(sourceId, importer) {
          const normalizedSource = sourceId.replaceAll('\\', '/');
          const normalizedImporter = importer?.replaceAll('\\', '/');
          if (
            (normalizedSource === './storage.ts' ||
              normalizedSource.endsWith('/src/sync/storage.ts')) &&
            normalizedImporter?.includes('/src/sync/coordinator.ts')
          ) {
            return virtualStorageId;
          }
          return null;
        },
        load(id) {
          if (id !== virtualStorageId) return null;
          return `
            const hooks = globalThis.${storageHooksKey};
            export const loadSyncDeviceState = (...args) => hooks.load(...args);
            export const saveSyncDeviceState = (...args) => hooks.save(...args);
          `;
        },
      },
    ],
    server: { middlewareMode: true },
  });

  type ObservableCoordinator = {
    disconnect(): Promise<void>;
    destroy(): void;
    getSnapshot(): SyncViewState;
    initialize(): Promise<void>;
    subscribe(
      listener: (state: {
        connection: string;
        dirty: boolean;
        progress: { phase: string };
      }) => void,
    ): () => void;
    retryIntegrityVerification(): Promise<void>;
    resetDriveSyncFromThisDevice(): Promise<void>;
    syncNow(reason?: 'manual' | 'automatic'): Promise<void>;
  };
  type MutableCoordinatorInternals = {
    state: SyncDeviceState;
    identity: {
      hasDeviceSession: boolean;
      disconnectAll(): Promise<void>;
      disconnectCurrent(): Promise<void>;
    };
    local: {
      applySnapshot(
        snapshot: SyncSnapshot,
        downloadedPdfs: ReadonlyMap<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{
        changedDocumentIds: string[];
        deletedDocumentIds: string[];
      }>;
      createSnapshot(): Promise<SyncSnapshot>;
      validateSnapshot(snapshot: SyncSnapshot): void;
    };
    repository: {
      downloadPdf(): Promise<never>;
      getRootFolderUrl(): string;
      pull(
        state: SyncDeviceState,
        signal: AbortSignal,
      ): Promise<{
        snapshot: SyncSnapshot;
        rootFolderId: string;
        usedCachedSnapshot: boolean;
        manifestVersion?: string;
        requiresPublicationUpgrade?: boolean;
      }>;
      push(
        snapshot: SyncSnapshot,
        localPdfs: readonly LocalSyncPdf[],
        state: SyncDeviceState,
        signal: AbortSignal,
      ): ReturnType<GoogleDriveSyncRepository['push']>;
      resetFromLocal(
        snapshot: SyncSnapshot,
        localPdfs: readonly LocalSyncPdf[],
        state: SyncDeviceState,
        signal: AbortSignal,
        onProgress?: (progress: SyncProgress) => void,
      ): ReturnType<GoogleDriveSyncRepository['resetFromLocal']>;
    };
  };

  const waitFor = async (
    coordinator: ObservableCoordinator,
    predicate: (state: ReturnType<ObservableCoordinator['getSnapshot']>) => boolean,
  ) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate(coordinator.getSnapshot())) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail(
      `Coordinator state did not settle: ${JSON.stringify(coordinator.getSnapshot())}`,
    );
  };

  let coordinatorModule: typeof import('../src/sync/coordinator.ts') | undefined;
  let notifyPersistentChange: ((detail: { kind: 'library' }) => void) | undefined;
  const activeCoordinators = new Set<ObservableCoordinator>();
  const createCoordinator = async (
    initialDirty: boolean,
    pull: MutableCoordinatorInternals['repository']['pull'] = async () => ({
      snapshot: snapshot([]),
      rootFolderId: 'root-test',
      usedCachedSnapshot: false,
    }),
  ) => {
    assert.ok(coordinatorModule);
    scheduledTimeouts.length = 0;
    savedStates = [];
    const initialState = { ...deviceState(), dirty: initialDirty };
    const coordinator = new coordinatorModule.GoogleDriveSyncCoordinator(
      async () => initialState,
    ) as ObservableCoordinator;
    await coordinator.initialize();
    const internals = coordinator as unknown as MutableCoordinatorInternals;
    internals.identity = {
      hasDeviceSession: true,
      async disconnectAll() {},
      async disconnectCurrent() {},
    };
    internals.local = {
      async applySnapshot() {
        return { changedDocumentIds: [], deletedDocumentIds: [] };
      },
      async createSnapshot() {
        return snapshot([]);
      },
      validateSnapshot() {},
    };
    internals.repository = {
      async downloadPdf() {
        throw new Error('Unexpected PDF download.');
      },
      getRootFolderUrl() {
        return 'https://drive.example.test/folders/root-test';
      },
      pull,
      async push() {
        throw new Error('Unexpected cloud push.');
      },
      async resetFromLocal() {
        throw new Error('Unexpected Drive reset.');
      },
    };
    activeCoordinators.add(coordinator);
    return coordinator;
  };
  const destroyCoordinator = (coordinator: ObservableCoordinator) => {
    coordinator.destroy();
    activeCoordinators.delete(coordinator);
  };
  const isSynced = (coordinator: ObservableCoordinator) => {
    const state = coordinator.getSnapshot();
    return (
      coordinatorModule?.getSyncUiStatus(state) === 'synced' &&
      state.progress.phase === 'idle'
    );
  };
  const uiStatus = (coordinator: ObservableCoordinator) => {
    assert.ok(coordinatorModule);
    return coordinatorModule.getSyncUiStatus(coordinator.getSnapshot());
  };

  try {
    coordinatorModule = (await server.ssrLoadModule(
      '/src/sync/coordinator.ts',
    )) as typeof import('../src/sync/coordinator.ts');
    const driveRepositoryModule = (await server.ssrLoadModule(
      '/src/sync/driveRepository.ts',
    )) as typeof import('../src/sync/driveRepository.ts');
    const cloudFormatModule = (await server.ssrLoadModule(
      '/src/sync/cloudFormat.ts',
    )) as typeof import('../src/sync/cloudFormat.ts');
    const persistentChangeModule = await server.ssrLoadModule(
      '/src/services/persistentChange.ts',
    );
    notifyPersistentChange = persistentChangeModule.notifyPersistentChange as (detail: {
      kind: 'library';
    }) => void;

    await context.test(
      'pending transitions through syncing to synced and clears progress',
      async () => {
        const coordinator = await createCoordinator(false);
        const states: Array<{ connection: string; dirty: boolean; phase: string }> = [];
        const unsubscribe = coordinator.subscribe((state) => {
          states.push({
            connection: state.connection,
            dirty: state.dirty,
            phase: state.progress.phase,
          });
        });
        try {
          await coordinator.syncNow('manual');
          assert.ok(isSynced(coordinator));
          assert.ok(notifyPersistentChange);
          notifyPersistentChange({ kind: 'library' });
          await waitFor(
            coordinator,
            (state) => state.connection === 'connected' && state.dirty,
          );
          assert.equal(uiStatus(coordinator), 'pending');
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');

          await coordinator.syncNow('manual');
          assert.ok(
            states.some((state) => state.connection === 'connected' && state.dirty),
          );
          assert.ok(states.some((state) => state.connection === 'syncing'));
          assert.ok(isSynced(coordinator));
          assert.equal(uiStatus(coordinator), 'synced');
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
        } finally {
          unsubscribe();
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test('a successful empty queue cannot remain pending', async () => {
      const coordinator = await createCoordinator(true);
      try {
        assert.equal(coordinator.getSnapshot().dirty, true);
        await coordinator.syncNow('manual');
        assert.ok(isSynced(coordinator));
        assert.equal(uiStatus(coordinator), 'synced');
        assert.equal(savedStates.at(-1)?.dirty, false);
      } finally {
        destroyCoordinator(coordinator);
      }
    });

    await context.test(
      'a mutation after synced returns the public state to pending',
      async () => {
        const coordinator = await createCoordinator(false);
        try {
          await coordinator.syncNow('manual');
          assert.ok(isSynced(coordinator));
          assert.ok(notifyPersistentChange);
          notifyPersistentChange({ kind: 'library' });
          await waitFor(
            coordinator,
            (state) => state.connection === 'connected' && state.dirty,
          );
          assert.equal(uiStatus(coordinator), 'pending');
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
          assert.equal(scheduledTimeouts.length, 1);
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'overlapping manual and automatic sync cannot regress the final state',
      async () => {
        let pullCalls = 0;
        let releasePull: (() => void) | undefined;
        let delayNextPull = false;
        const pull: MutableCoordinatorInternals['repository']['pull'] = async () => {
          pullCalls += 1;
          if (delayNextPull) {
            await new Promise<void>((resolve) => {
              releasePull = resolve;
            });
          }
          return {
            snapshot: snapshot([]),
            rootFolderId: 'root-test',
            usedCachedSnapshot: false,
          };
        };
        const coordinator = await createCoordinator(false, pull);
        try {
          await coordinator.syncNow('manual');
          assert.ok(notifyPersistentChange);
          notifyPersistentChange({ kind: 'library' });
          await waitFor(
            coordinator,
            (state) => state.connection === 'connected' && state.dirty,
          );
          assert.equal(scheduledTimeouts.length, 1);

          delayNextPull = true;
          const manual = coordinator.syncNow('manual');
          const automatic = coordinator.syncNow('automatic');
          assert.equal(manual, automatic);
          scheduledTimeouts[0]();
          await waitFor(coordinator, (state) => state.connection === 'syncing');
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(pullCalls, 2);

          assert.ok(releasePull);
          releasePull();
          await manual;
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(pullCalls, 2);
          assert.ok(isSynced(coordinator));
          assert.equal(uiStatus(coordinator), 'synced');
        } finally {
          releasePull?.();
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'a failed sync is never reported as synced and clears progress',
      async () => {
        const coordinator = await createCoordinator(true, async () => {
          throw new Error('Sanitized test sync failure.');
        });
        try {
          await assert.rejects(
            () => coordinator.syncNow('manual'),
            /Sanitized test sync failure/u,
          );
          const state = coordinator.getSnapshot();
          assert.notEqual(state.connection, 'connected');
          assert.equal(state.dirty, true);
          assert.equal(state.progress.phase, 'idle');
          assert.equal(isSynced(coordinator), false);
          assert.equal(uiStatus(coordinator), 'attention');
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'reset validates local state before the repository can mutate Drive',
      async () => {
        const coordinator = await createCoordinator(false);
        try {
          const internals = coordinator as unknown as MutableCoordinatorInternals;
          let resetCalls = 0;
          internals.local.validateSnapshot = () => {
            throw new Error('Invalid local reset source.');
          };
          internals.repository.resetFromLocal = async () => {
            resetCalls += 1;
            throw new Error('Drive reset must not start.');
          };
          await assert.rejects(
            () => coordinator.resetDriveSyncFromThisDevice(),
            /Invalid local reset source/u,
          );
          assert.equal(resetCalls, 0);
          assert.equal(coordinator.getSnapshot().resetRequired, false);
          assert.equal(uiStatus(coordinator), 'attention');
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'reset exclusively cancels an active autosync and rejects a stale autosync timer',
      async () => {
        const events: string[] = [];
        let delayPull = false;
        const pullStarted = deferred();
        const pull: MutableCoordinatorInternals['repository']['pull'] = async (
          _state,
          signal,
        ) => {
          if (delayPull) {
            events.push('automatic:pull:start');
            pullStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  events.push('automatic:pull:abort');
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          }
          return {
            snapshot: snapshot([]),
            rootFolderId: 'root-test',
            usedCachedSnapshot: false,
          };
        };
        const coordinator = await createCoordinator(false, pull);
        const resetRelease = deferred();
        const resetStarted = deferred();
        try {
          assert.ok(notifyPersistentChange);
          notifyPersistentChange({ kind: 'library' });
          await waitFor(coordinator, (state) => state.dirty);
          assert.equal(scheduledTimeouts.length, 1);
          const staleTimer = scheduledTimeouts[0];
          delayPull = true;
          const automatic = coordinator.syncNow('automatic').catch((error) => error);
          await pullStarted.promise;

          const internals = coordinator as unknown as MutableCoordinatorInternals;
          let resetCalls = 0;
          internals.repository.resetFromLocal = async (local) => {
            resetCalls += 1;
            events.push('reset:start');
            resetStarted.resolve();
            await resetRelease.promise;
            events.push('reset:end');
            return {
              snapshot: local,
              manifestVersion: 'reset-head',
              pdfsUploaded: 0,
              filesUpdated: 1,
              filesTrashed: 2,
            };
          };
          const reset = coordinator.resetDriveSyncFromThisDevice();
          await resetStarted.promise;
          staleTimer();
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(resetCalls, 1);
          await assert.rejects(() => coordinator.syncNow('automatic'), /reset/u);
          resetRelease.resolve();
          await reset;
          assert.match(String(await automatic), /Sync cancelled/u);
          assert.deepEqual(events, [
            'automatic:pull:start',
            'automatic:pull:abort',
            'reset:start',
            'reset:end',
          ]);
          assert.equal(resetCalls, 1);
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
          assert.equal(coordinator.getSnapshot().resetRequired, false);
          assert.equal(uiStatus(coordinator), 'synced');
        } finally {
          resetRelease.resolve();
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'a failed reset remains attention and persistently blocks ordinary sync',
      async () => {
        const coordinator = await createCoordinator(false);
        try {
          await coordinator.syncNow('manual');
          const previousSuccess = coordinator.getSnapshot().lastSuccessfulAt;
          assert.ok(previousSuccess);
          const internals = coordinator as unknown as MutableCoordinatorInternals;
          internals.repository.resetFromLocal = async () => {
            throw new Error('Reset publication verification failed.');
          };
          await assert.rejects(
            () => coordinator.resetDriveSyncFromThisDevice(),
            /Reset publication verification failed/u,
          );
          const failed = coordinator.getSnapshot();
          assert.equal(failed.progress.phase, 'idle');
          assert.equal(failed.dirty, true);
          assert.equal(failed.autoSync, false);
          assert.equal(failed.resetRequired, true);
          assert.equal(failed.lastSuccessfulAt, previousSuccess);
          assert.equal(uiStatus(coordinator), 'attention');
          assert.equal(isSynced(coordinator), false);
          assert.equal(savedStates.at(-1)?.resetIncomplete, true);
          await assert.rejects(() => coordinator.syncNow('manual'), /reset/u);
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'successful integrity recovery confirmation clears the prior attention state',
      async () => {
        const clean = snapshot([]);
        const actualPayload = partitionSnapshot(clean).library;
        const reference = { fileId: 'legacy-library', sha256: 'a'.repeat(64) };
        const failure = new driveRepositoryModule.GoogleDrivePayloadIntegrityError({
          cause: new cloudFormatModule.CloudPayloadIntegrityError({
            expectedHash: reference.sha256,
            actualHash: 'b'.repeat(64),
            byteLength: 4,
            actualPayload,
          }),
          context: {
            logicalType: 'library-metadata',
            logicalPath: '/39Note/library.json',
          },
          reference,
          manifest: {
            app: '39Note',
            syncSchemaVersion: SYNC_SCHEMA_VERSION,
            generatedAt: 1,
            generatedBy: 'legacy-device',
            library: reference,
            aiSettings: { fileId: 'legacy-ai', sha256: 'c'.repeat(64) },
            documents: [],
          },
          manifestFile: {
            id: 'legacy-manifest',
            name: '39note-manifest.json',
            mimeType: 'application/json',
          },
          fileIdFingerprint: 'd'.repeat(12),
          retryOutcome: 'persistent',
          manifestSourceId: 'legacy-source',
        });
        let recovered = false;
        let pullCalls = 0;
        const coordinator = await createCoordinator(true, async () => {
          pullCalls += 1;
          if (!recovered) throw failure;
          return {
            snapshot: clean,
            rootFolderId: 'root-test',
            manifestVersion: 'recovery-head',
            usedCachedSnapshot: false,
          };
        });
        try {
          const internals = coordinator as unknown as MutableCoordinatorInternals;
          const repository = internals.repository as typeof internals.repository & {
            canRepairFromSnapshot(): Promise<boolean>;
            canMergeValidRemoteFromSnapshot(): Promise<boolean>;
            repairFromValidRemoteGeneration(): Promise<SyncConflict[]>;
          };
          repository.canRepairFromSnapshot = async () => false;
          repository.canMergeValidRemoteFromSnapshot = async () => true;
          repository.repairFromValidRemoteGeneration = async () => {
            recovered = true;
            return [];
          };
          await assert.rejects(() => coordinator.syncNow('manual'), /integrity/u);
          assert.equal(uiStatus(coordinator), 'attention');
          await (
            coordinator as ObservableCoordinator & {
              preserveAndMergeRemoteIntegrityGeneration(): Promise<void>;
            }
          ).preserveAndMergeRemoteIntegrityGeneration();
          assert.equal(pullCalls, 2);
          assert.equal(coordinator.getSnapshot().integrityIssue, undefined);
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
          assert.equal(uiStatus(coordinator), 'synced');
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'read-only Retry remains attention and cannot pull, apply, push, or schedule autosync',
      async () => {
        const expectedHash = 'a'.repeat(64);
        const actualHash = 'b'.repeat(64);
        const contextValue = {
          logicalType: 'document-state' as const,
          logicalPath: '/39Note/documents/document-doc-1/state.json',
          documentId: 'doc-1',
        };
        const reference = { fileId: 'state-generation-a', sha256: expectedHash };
        const manifest = {
          app: '39Note' as const,
          syncSchemaVersion: SYNC_SCHEMA_VERSION,
          generatedAt: 1,
          generatedBy: 'device-a',
          payloadStorage: 'immutable-v1' as const,
          library: { fileId: 'library', sha256: 'c'.repeat(64) },
          aiSettings: { fileId: 'ai-settings', sha256: 'd'.repeat(64) },
          documents: [
            {
              documentId: 'doc-1',
              folderId: 'document-doc-1',
              state: reference,
            },
          ],
        };
        const failure = new driveRepositoryModule.GoogleDrivePayloadIntegrityError({
          cause: new cloudFormatModule.CloudPayloadIntegrityError({
            expectedHash,
            actualHash,
            byteLength: 4,
          }),
          context: contextValue,
          reference,
          manifest,
          manifestFile: {
            id: 'manifest',
            name: '39note-manifest.json',
            mimeType: 'application/json',
            version: '7',
          },
          fileIdFingerprint: 'e'.repeat(12),
          retryOutcome: 'persistent',
        });
        let pullCalls = 0;
        const coordinator = await createCoordinator(true, async () => {
          pullCalls += 1;
          throw failure;
        });
        try {
          await assert.rejects(
            () => coordinator.syncNow('manual'),
            /payload failed its integrity check/u,
          );
          const failedState = coordinator.getSnapshot();
          assert.equal(uiStatus(coordinator), 'attention');
          assert.equal(failedState.progress.phase, 'idle');
          assert.equal(failedState.integrityIssue?.logicalType, 'document-state');
          assert.equal(failedState.integrityIssue?.documentId, 'doc-1');
          assert.equal(failedState.lastSuccessfulAt, undefined);

          const internals = coordinator as unknown as MutableCoordinatorInternals;
          let verificationCalls = 0;
          let pushCalls = 0;
          let applyCalls = 0;
          internals.local.createSnapshot = async () =>
            snapshot([validDocumentEntity()]);
          (
            internals.local as MutableCoordinatorInternals['local'] & {
              validateSnapshot(snapshot: SyncSnapshot): void;
            }
          ).validateSnapshot = () => undefined;
          internals.local.applySnapshot = async () => {
            applyCalls += 1;
            return { changedDocumentIds: [], deletedDocumentIds: [] };
          };
          const repository = internals.repository as typeof internals.repository & {
            canRepairFromSnapshot(): Promise<boolean>;
            canMergeValidRemoteFromSnapshot(): Promise<boolean>;
            verifyIntegrityFailureReadOnly(): Promise<{
              failure: null;
              diagnostic: GoogleDrivePayloadIntegrityError['diagnostic'];
              verifiedPayload: ReturnType<typeof partitionSnapshot>['library'];
            }>;
          };
          repository.canRepairFromSnapshot = async () => false;
          repository.canMergeValidRemoteFromSnapshot = async () => false;
          repository.verifyIntegrityFailureReadOnly = async () => {
            verificationCalls += 1;
            const verifiedSnapshot = snapshot([validDocumentEntity()]);
            const verifiedPayload =
              partitionSnapshot(verifiedSnapshot).documents.get('doc-1')?.state;
            assert.ok(verifiedPayload);
            return {
              failure: null,
              verifiedPayload,
              diagnostic: {
                ...failure.diagnostic,
                verificationState: 'verified',
                retryOutcome: 'recovered',
                evidenceStable: false,
                actualPayloadValid: true,
                validAlternateGenerationAvailable: false,
                localPayloadSemanticallyValid: false,
                remotePayloadSemanticallyValid: true,
                recommendedRecoveryChoices: ['continue-sync'],
              },
            };
          };
          repository.push = async () => {
            pushCalls += 1;
            throw new Error('Retry verification must not push.');
          };
          const savedBeforeRetry = savedStates.length;
          await coordinator.retryIntegrityVerification();
          const recoveredState = coordinator.getSnapshot();
          assert.equal(recoveredState.integrityIssue?.verificationState, 'verified');
          assert.equal(recoveredState.integrityIssue?.retryOutcome, 'recovered');
          assert.equal(recoveredState.integrityIssue?.documentTitle, 'Paper');
          assert.equal(
            recoveredState.integrityIssue?.localPayloadSemanticallyValid,
            true,
          );
          assert.equal(
            recoveredState.integrityIssue?.remotePayloadSemanticallyValid,
            true,
          );
          assert.equal(recoveredState.error, 'Drive data needs verification.');
          assert.equal(recoveredState.issue?.code, 'drive-integrity-mismatch');
          assert.equal(recoveredState.progress.phase, 'idle');
          assert.equal(uiStatus(coordinator), 'attention');
          assert.equal(recoveredState.lastSuccessfulAt, undefined);
          assert.equal(verificationCalls, 1);
          assert.equal(pullCalls, 1);
          assert.equal(applyCalls, 0);
          assert.equal(pushCalls, 0);
          assert.equal(savedStates.length, savedBeforeRetry);

          assert.ok(notifyPersistentChange);
          notifyPersistentChange({ kind: 'library' });
          await waitFor(coordinator, (state) => state.dirty);
          assert.equal(scheduledTimeouts.length, 0);
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'direct remote repair refuses a semantically invalid generation without writes',
      async () => {
        const base = snapshot([validDocumentEntity()]);
        const actualPayload = {
          app: '39Note' as const,
          syncSchemaVersion: SYNC_SCHEMA_VERSION,
          entities: [
            entity(
              'print-draft',
              'doc-1',
              { documentId: 'doc-1', editorStateJson: 42 },
              2,
              'device-b',
              'b',
              'doc-1',
            ),
          ],
          tombstones: [],
        };
        const expectedHash = 'a'.repeat(64);
        const actualHash = 'b'.repeat(64);
        const reference = { fileId: 'productivity-generation-a', sha256: expectedHash };
        const failure = new driveRepositoryModule.GoogleDrivePayloadIntegrityError({
          cause: new cloudFormatModule.CloudPayloadIntegrityError({
            expectedHash,
            actualHash,
            byteLength: 4,
            actualPayload,
          }),
          context: {
            logicalType: 'productivity-data',
            logicalPath: '/39Note/documents/document-doc-1/productivity.json',
            documentId: 'doc-1',
          },
          reference,
          manifest: {
            app: '39Note',
            syncSchemaVersion: SYNC_SCHEMA_VERSION,
            generatedAt: 1,
            generatedBy: 'device-a',
            payloadStorage: 'immutable-v1',
            library: { fileId: 'library', sha256: 'c'.repeat(64) },
            aiSettings: { fileId: 'ai-settings', sha256: 'd'.repeat(64) },
            documents: [
              {
                documentId: 'doc-1',
                folderId: 'document-doc-1',
                state: { fileId: 'state', sha256: 'e'.repeat(64) },
                productivity: reference,
              },
            ],
          },
          manifestFile: {
            id: 'manifest',
            name: '39note-manifest.json',
            mimeType: 'application/json',
            version: '7',
          },
          fileIdFingerprint: 'f'.repeat(12),
          retryOutcome: 'persistent',
        });
        const coordinator = await createCoordinator(true, async () => {
          throw failure;
        });
        try {
          const internals = coordinator as unknown as MutableCoordinatorInternals & {
            integrityFailure: GoogleDrivePayloadIntegrityError;
          };
          const { BrowserSyncLocalAdapter } = (await server.ssrLoadModule(
            '/src/sync/localAdapter.ts',
          )) as typeof import('../src/sync/localAdapter.ts');
          const validator = new BrowserSyncLocalAdapter();
          internals.local.createSnapshot = async () => base;
          (
            internals.local as MutableCoordinatorInternals['local'] & {
              validateSnapshot(snapshot: SyncSnapshot): void;
            }
          ).validateSnapshot = (candidate) => validator.validateSnapshot(candidate);
          let repairWrites = 0;
          const repairRepository =
            internals.repository as typeof internals.repository & {
              canRepairFromSnapshot(): Promise<boolean>;
              canMergeValidRemoteFromSnapshot(): Promise<boolean>;
              repairFromValidRemoteGeneration(): Promise<void>;
            };
          repairRepository.canRepairFromSnapshot = async () => false;
          repairRepository.canMergeValidRemoteFromSnapshot = async () => true;
          repairRepository.repairFromValidRemoteGeneration = async () => {
            repairWrites += 1;
          };
          await assert.rejects(
            () => coordinator.syncNow('manual'),
            /payload failed its integrity check/u,
          );
          assert.equal(
            coordinator.getSnapshot().integrityIssue?.remotePayloadSemanticallyValid,
            false,
          );
          assert.equal(
            coordinator.getSnapshot().integrityIssue?.remoteMergeAvailable,
            false,
          );
          assert.deepEqual(
            coordinator.getSnapshot().integrityIssue?.recommendedRecoveryChoices,
            ['manual-inspection'],
          );

          await assert.rejects(
            () =>
              (
                coordinator as ObservableCoordinator & {
                  preserveAndMergeRemoteIntegrityGeneration(): Promise<void>;
                }
              ).preserveAndMergeRemoteIntegrityGeneration(),
            /failed semantic validation/u,
          );
          assert.equal(repairWrites, 0);
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'a manifest race retry retains the pre-push versions, tombstones, and conflict journal',
      async () => {
        const noteKey = createSyncEntityKey('note', 'note-1', 'doc-1');
        const deletedKey = createSyncEntityKey('annotation', 'deleted-mark', 'doc-1');
        const localNote = entity(
          'note',
          'note-1',
          { content: 'Local winner' },
          4,
          'device-local',
          'a',
          'doc-1',
        );
        const remoteNote = entity(
          'note',
          'note-1',
          { content: 'Remote alternate' },
          3,
          'device-remote',
          'b',
          'doc-1',
        );
        const deletion = {
          key: deletedKey,
          kind: 'annotation' as const,
          id: 'deleted-mark',
          documentId: 'doc-1',
          deletedAt: 5,
          deviceId: 'device-local',
        };
        let currentLocal = {
          ...snapshot([localNote], 'device-local'),
          tombstones: [deletion],
        };
        const remote = snapshot([remoteNote], 'device-remote');
        let pullCalls = 0;
        let pushCalls = 0;
        let checkpointConflictId: string | undefined;
        let checkpointObservedOnRetry = false;
        const coordinator = await createCoordinator(true, async (state) => {
          pullCalls += 1;
          if (pullCalls === 2) {
            assert.deepEqual(state.entityVersions[noteKey], localNote.version);
            assert.deepEqual(state.tombstones, [deletion]);
            assert.ok(checkpointConflictId);
            assert.ok(
              state.conflicts.some((conflict) => conflict.id === checkpointConflictId),
            );
            checkpointObservedOnRetry = true;
          }
          return {
            snapshot: remote,
            manifestVersion: `remote-${pullCalls}`,
            rootFolderId: 'root-test',
            usedCachedSnapshot: false,
          };
        });
        try {
          const internals = coordinator as unknown as MutableCoordinatorInternals;
          internals.local = {
            async createSnapshot() {
              return structuredClone(currentLocal);
            },
            async applySnapshot(merged) {
              currentLocal = structuredClone(merged);
              return { changedDocumentIds: ['doc-1'], deletedDocumentIds: [] };
            },
          };
          internals.repository.push = async (outbound, _pdfs, state) => {
            pushCalls += 1;
            assert.deepEqual(state.entityVersions[noteKey], localNote.version);
            assert.deepEqual(state.tombstones, [deletion]);
            assert.ok(state.conflicts.length >= 1);
            checkpointConflictId ??= state.conflicts[0].id;
            assert.ok(
              savedStates.some(
                (saved) =>
                  saved.entityVersions[noteKey]?.hash === localNote.version.hash &&
                  saved.tombstones.some((item) => item.key === deletedKey) &&
                  saved.conflicts.some(
                    (conflict) => conflict.id === checkpointConflictId,
                  ),
              ),
            );
            if (pushCalls === 1) {
              throw new driveRepositoryModule.RemoteManifestChangedError();
            }
            return {
              snapshot: outbound,
              manifestVersion: 'published-after-retry',
              pdfsUploaded: 0,
              filesUpdated: 1,
            };
          };

          await coordinator.syncNow('manual');
          assert.equal(pullCalls, 2);
          assert.equal(pushCalls, 2);
          assert.equal(checkpointObservedOnRetry, true);
          assert.ok(checkpointConflictId);
          assert.ok(
            coordinator
              .getSnapshot()
              .conflicts.some((conflict) => conflict.id === checkpointConflictId),
          );
          assert.equal(coordinator.getSnapshot().connection, 'connected');
          assert.equal(coordinator.getSnapshot().dirty, false);
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
          assert.equal(uiStatus(coordinator), 'attention');
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'a persistent user change aborts apply and leaves the cycle pending',
      async () => {
        const coordinator = await createCoordinator(false);
        const applyStarted = deferred();
        let applySignal: AbortSignal | undefined;
        try {
          const internals = coordinator as unknown as MutableCoordinatorInternals;
          internals.local.applySnapshot = async (
            _snapshot,
            _downloadedPdfs,
            signal,
          ) => {
            assert.ok(signal);
            applySignal = signal;
            applyStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            });
            return { changedDocumentIds: [], deletedDocumentIds: [] };
          };

          const syncing = coordinator.syncNow('manual');
          await applyStarted.promise;
          assert.ok(notifyPersistentChange);
          notifyPersistentChange({ kind: 'library' });
          await assert.rejects(syncing, /Local data changed while the sync merge/u);
          await waitFor(
            coordinator,
            (state) => state.connection === 'connected' && state.dirty,
          );
          assert.equal(applySignal?.aborted, true);
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
          assert.equal(coordinator.getSnapshot().lastSuccessfulAt, undefined);
          assert.equal(uiStatus(coordinator), 'pending');
          assert.equal(isSynced(coordinator), false);
          assert.equal(savedStates.at(-1)?.dirty, true);
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'cancelling an active clean cycle clears progress without claiming success',
      async () => {
        let delayPull = false;
        const pull: MutableCoordinatorInternals['repository']['pull'] = async (
          _state,
          signal,
        ) => {
          if (delayPull) {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            });
          }
          return {
            snapshot: snapshot([]),
            rootFolderId: 'root-test',
            usedCachedSnapshot: false,
          };
        };
        const coordinator = await createCoordinator(false, pull);
        try {
          await coordinator.syncNow('manual');
          delayPull = true;
          const cancelled = coordinator.syncNow('manual');
          await waitFor(coordinator, (state) => state.connection === 'syncing');
          (coordinator as unknown as { cancel(): void }).cancel();
          await assert.rejects(cancelled, /Sync cancelled/u);
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
          assert.equal(uiStatus(coordinator), 'connected');
        } finally {
          destroyCoordinator(coordinator);
        }
      },
    );

    await context.test(
      'disconnect blocks new sync ownership until the broker operation finishes',
      async () => {
        let delayPull = false;
        let pullCalls = 0;
        const pull: MutableCoordinatorInternals['repository']['pull'] = async (
          _state,
          signal,
        ) => {
          pullCalls += 1;
          if (delayPull) {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            });
          }
          return {
            snapshot: snapshot([]),
            rootFolderId: 'root-test',
            usedCachedSnapshot: false,
          };
        };
        const coordinator = await createCoordinator(false, pull);
        let releaseBrokerDisconnect: (() => void) | undefined;
        try {
          await coordinator.syncNow('manual');
          const internals = coordinator as unknown as MutableCoordinatorInternals;
          internals.identity.disconnectCurrent = () =>
            new Promise<void>((resolve) => {
              releaseBrokerDisconnect = resolve;
            });

          delayPull = true;
          const activeRun = coordinator.syncNow('manual');
          const activeRunResult = activeRun.then(
            () => null,
            (error: unknown) => error,
          );
          await waitFor(coordinator, (state) => state.connection === 'syncing');
          const disconnecting = coordinator.disconnect();
          await waitFor(coordinator, (state) => state.connection === 'disconnecting');
          await assert.rejects(() => coordinator.syncNow('manual'), /disconnecting/u);
          assert.equal(pullCalls, 2);

          for (
            let attempt = 0;
            attempt < 20 && !releaseBrokerDisconnect;
            attempt += 1
          ) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          assert.ok(releaseBrokerDisconnect);
          releaseBrokerDisconnect();
          await disconnecting;
          assert.match(String(await activeRunResult), /Sync cancelled/u);
          assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
          assert.equal(coordinator.getSnapshot().connection, 'not-configured');
        } finally {
          releaseBrokerDisconnect?.();
          destroyCoordinator(coordinator);
        }
      },
    );
  } finally {
    for (const coordinator of activeCoordinators) coordinator.destroy();
    await server.close();
    if (previousStorageHooks)
      Object.defineProperty(globalThis, storageHooksKey, previousStorageHooks);
    else Reflect.deleteProperty(globalThis, storageHooksKey);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument)
      Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousNavigator)
      Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('deterministic merge uses timestamp and device ID and preserves meaningful conflicts', () => {
  const key = createSyncEntityKey('note', 'note-1', 'doc-1');
  const local = snapshot([
    entity('note', 'note-1', { content: 'local' }, 20, 'device-a', 'a', 'doc-1'),
  ]);
  const remote = snapshot(
    [entity('note', 'note-1', { content: 'remote' }, 20, 'device-z', 'b', 'doc-1')],
    'device-z',
  );
  const merged = mergeSyncSnapshots(local, remote, { [key]: 'c'.repeat(64) }, 30);
  assert.deepEqual(merged.snapshot.entities[0].value, { content: 'remote' });
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.conflicts[0].alternateValue, { content: 'local' });
});

test('first sync safely handles local-only, cloud-only, and independent documents', () => {
  const localDocument = entity(
    'document',
    'local-doc',
    { displayTitle: 'Local' },
    10,
    'device-a',
    'a',
  );
  const cloudDocument = entity(
    'document',
    'cloud-doc',
    { displayTitle: 'Cloud' },
    11,
    'device-z',
    'b',
  );
  assert.deepEqual(
    mergeSyncSnapshots(
      snapshot([localDocument]),
      snapshot([]),
      {},
    ).snapshot.entities.map((item) => item.id),
    ['local-doc'],
  );
  assert.deepEqual(
    mergeSyncSnapshots(
      snapshot([]),
      snapshot([cloudDocument]),
      {},
    ).snapshot.entities.map((item) => item.id),
    ['cloud-doc'],
  );
  assert.deepEqual(
    mergeSyncSnapshots(snapshot([localDocument]), snapshot([cloudDocument]), {})
      .snapshot.entities.map((item) => item.id)
      .sort(),
    ['cloud-doc', 'local-doc'],
  );
});

test('newer edit beats an older tombstone while newer deletion beats an edit', () => {
  const note = entity(
    'note',
    'note-1',
    { content: 'edited' },
    20,
    'device-a',
    'a',
    'doc-1',
  );
  const oldDeletion = {
    key: note.key,
    kind: 'note' as const,
    id: 'note-1',
    documentId: 'doc-1',
    deletedAt: 19,
    deviceId: 'device-z',
  };
  const newDeletion = { ...oldDeletion, deletedAt: 21 };
  assert.equal(
    mergeSyncSnapshots(
      snapshot([note]),
      { ...snapshot([]), tombstones: [oldDeletion] },
      {},
    ).snapshot.entities.length,
    1,
  );
  assert.equal(
    mergeSyncSnapshots(
      snapshot([note]),
      { ...snapshot([]), tombstones: [newDeletion] },
      {},
    ).snapshot.entities.length,
    0,
  );
});

test('newer tombstones suppress entities and deleted documents suppress PDFs', () => {
  const document = entity(
    'document',
    'doc-1',
    { displayTitle: 'Paper' },
    10,
    'device-a',
    'd',
  );
  const note = entity(
    'note',
    'note-1',
    { content: 'Still locally present' },
    12,
    'device-a',
    'n',
    'doc-1',
  );
  const local = {
    ...snapshot([document, note]),
    pdfs: [
      {
        documentId: 'doc-1',
        fileName: 'paper.pdf',
        mimeType: 'application/pdf',
        size: 12,
        lastModified: 1,
        storedAt: 1,
        sha256: 'f'.repeat(64),
      },
    ],
  };
  const remote = {
    ...snapshot([], 'device-z'),
    tombstones: [
      {
        key: document.key,
        kind: 'document' as const,
        id: 'doc-1',
        deletedAt: 11,
        deviceId: 'device-z',
      },
    ],
  };
  const merged = mergeSyncSnapshots(local, remote, {});
  assert.equal(merged.snapshot.entities.length, 0);
  assert.equal(merged.snapshot.pdfs.length, 0);
});

test('matching PDF hashes retain the existing Drive file ID instead of uploading a duplicate', () => {
  const document = entity(
    'document',
    'doc-1',
    { displayTitle: 'Paper' },
    10,
    'device-a',
    'd',
  );
  const descriptor = {
    documentId: 'doc-1',
    fileName: 'paper.pdf',
    mimeType: 'application/pdf',
    size: 15 * 1024 * 1024,
    lastModified: 1,
    storedAt: 1,
    sha256: 'f'.repeat(64),
  };
  const local = { ...snapshot([document]), pdfs: [descriptor] };
  const remote = {
    ...snapshot([document], 'device-z'),
    pdfs: [{ ...descriptor, fileId: 'existing-drive-file' }],
  };
  const merged = mergeSyncSnapshots(local, remote, {});
  assert.equal(merged.snapshot.pdfs[0].fileId, 'existing-drive-file');
});

test('clean-device discovery finds the app-owned 39Note root before creating anything', async () => {
  const queries: string[] = [];
  let createCalls = 0;
  const root = {
    id: 'root-1',
    name: '39Note',
    mimeType: 'application/vnd.google-apps.folder',
    appProperties: { application: '39Note', role: 'root' },
  };
  const fakeDrive = {
    async listFiles(query: string) {
      queries.push(query);
      return query.includes("role' and value='root") ? [root] : [];
    },
    async createFolder() {
      createCalls += 1;
      return root;
    },
    async downloadText() {
      throw new Error('No manifest should be downloaded.');
    },
  } as unknown as DriveClient;
  const repository = new GoogleDriveSyncRepository(fakeDrive);
  const state = deviceState();
  const pulled = await repository.pull(state, new AbortController().signal);
  assert.equal(pulled.rootFolderId, 'root-1');
  assert.equal(state.driveFiles.rootFolderId, 'root-1');
  assert.equal(createCalls, 0);
  assert.match(queries[0], /appProperties has.*application.*39Note/);
  assert.equal(pulled.snapshot.entities.length, 0);
});

test('first push creates one visible root and uploads partitioned state plus the original PDF', async () => {
  const pushProgress: SyncProgress[] = [];
  const drive = new InMemoryDrive();
  const pdfBlob = new Blob(['%PDF-1.4\n39Note mock\n%%EOF'], {
    type: 'application/pdf',
  });
  const pdf = {
    documentId: 'doc-1',
    fileName: 'study.pdf',
    mimeType: 'application/pdf',
    size: pdfBlob.size,
    lastModified: 1,
    storedAt: 2,
    sha256: await sha256Hex(pdfBlob),
  };
  const firstSnapshot = {
    ...snapshot([
      entity('document', 'doc-1', { displayTitle: 'Study' }, 1, 'device-a', 'a'),
      entity(
        'annotation',
        'highlight-1',
        { type: 'highlight' },
        2,
        'device-a',
        'b',
        'doc-1',
      ),
      entity(
        'note',
        'note-1',
        { content: 'Editable note' },
        3,
        'device-a',
        'c',
        'doc-1',
      ),
      entity('collection', 'collection-1', { name: 'Research' }, 4, 'device-a', 'd'),
      entity('prompt-profile', 'prompt-1', { name: 'Study' }, 5, 'device-a', 'e'),
    ]),
    pdfs: [pdf],
  };
  const state = deviceState();
  const pushed = await new GoogleDriveSyncRepository(drive.asClient()).push(
    firstSnapshot,
    [{ ...pdf, blob: pdfBlob }],
    state,
    new AbortController().signal,
    (progress) => pushProgress.push(progress),
  );
  assert.deepEqual(
    drive.operations.filter((operation) => operation.startsWith('folder:')),
    ['folder:39Note', 'folder:documents', 'folder:document-doc-1'],
  );
  const uploadedNames = drive.operations
    .filter((operation) => operation.startsWith('upload:commit:'))
    .map((operation) => operation.slice('upload:commit:'.length));
  assert.equal(uploadedNames.length, 7);
  assert.equal(uploadedNames[0], 'README.txt');
  assert.match(uploadedNames[1], /^library-[a-f0-9]{16}\.json$/u);
  assert.match(uploadedNames[2], /^ai-settings-[a-f0-9]{16}\.json$/u);
  assert.match(uploadedNames[3], /^state-[a-f0-9]{16}\.json$/u);
  assert.match(uploadedNames[4], /^productivity-[a-f0-9]{16}\.json$/u);
  assert.equal(uploadedNames[5], `original-${pdf.sha256.slice(0, 16)}.pdf`);
  assert.match(uploadedNames[6], /^39note-manifest-v1-[a-f0-9]{64}\.json$/u);
  const publishedManifest = await drive.readManifest();
  assert.equal(publishedManifest.payloadStorage, 'immutable-v1');
  assert.equal(publishedManifest.manifestStorage, IMMUTABLE_MANIFEST_STORAGE);
  assert.ok(isImmutableCloudManifest(publishedManifest));
  assert.equal(await verifyCloudManifestGeneration(publishedManifest), true);
  assert.deepEqual(
    uploadedNames.map((name) => name.replace(/-[a-f0-9]{16}(?=\.json$)/u, '')),
    [
      'README.txt',
      'library.json',
      'ai-settings.json',
      'state.json',
      'productivity.json',
      `original-${pdf.sha256.slice(0, 16)}.pdf`,
      uploadedNames[6],
    ],
  );
  assert.equal(pushed.pdfsUploaded, 1);
  assert.equal(pushed.snapshot.pdfs[0].fileId, drive.findByRole('original-pdf')[0].id);
  assert.equal(state.driveFiles.rootFolderId, drive.findByRole('root')[0].id);
  assert.equal(
    [...drive.files.values()].filter(
      (file) => file.mimeType === 'application/vnd.google-apps.folder',
    ).length,
    3,
  );
  assert.equal(drive.files.size, 10);
  assert.deepEqual(pushProgress, [
    {
      phase: 'uploading',
      completed: 0,
      total: 1,
      detail: 'study.pdf',
    },
    {
      phase: 'uploading',
      completed: 1,
      total: 1,
      detail: 'study.pdf uploaded',
    },
    {
      phase: 'publishing',
      detail: 'Publishing immutable Drive generation',
    },
  ]);
  assert.deepEqual(
    drive.mutations
      .filter((mutation) => mutation.role === 'manifest-generation')
      .map((mutation) => mutation.method),
    ['POST'],
  );
});

test('exact pre-integrity schema-1 Drive data reads, validates, and upgrades without loss', async () => {
  const drive = new InMemoryDrive();
  const fixture = await comprehensiveLegacyFixture();
  const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
  assert.equal(legacy.manifest.payloadStorage, undefined);
  assert.deepEqual(Object.keys(legacy.manifest).sort(), [
    'aiSettings',
    'app',
    'documents',
    'generatedAt',
    'generatedBy',
    'library',
    'syncSchemaVersion',
  ]);
  assert.deepEqual(
    legacy.legacyFileIds.map((fileId) => drive.files.get(fileId)?.name),
    [
      'library.json',
      'ai-settings.json',
      'state.json',
      'productivity.json',
      'original.pdf',
    ],
  );
  for (const fileId of legacy.legacyFileIds.slice(0, 4)) {
    const payloadValue = JSON.parse(
      await (drive.files.get(fileId)?.content as Blob).text(),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payloadValue).sort(), [
      'app',
      'entities',
      'syncSchemaVersion',
      'tombstones',
    ]);
  }
  for (const reference of [
    legacy.manifest.library,
    legacy.manifest.aiSettings,
    legacy.manifest.documents[0].state,
    legacy.manifest.documents[0].productivity,
  ]) {
    assert.ok(reference);
    assert.deepEqual(Object.keys(reference).sort(), ['fileId', 'sha256']);
    assert.match(reference.sha256, /^[a-f0-9]{64}$/u);
  }
  const legacyBytes = new Map(
    legacy.legacyFileIds.map((fileId) => [fileId, drive.files.get(fileId)?.content]),
  );
  const state = deviceState();
  state.deviceId = 'current-reader';
  state.conflicts = structuredClone(fixture.conflicts);
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  const pulled = await repository.pull(state, new AbortController().signal);
  const expectedSnapshot: SyncSnapshot = {
    ...fixture.snapshot,
    pdfs: [
      {
        ...fixture.snapshot.pdfs[0],
        fileId: legacy.manifest.documents[0].pdf?.fileId,
      },
    ],
  };
  assert.equal(pulled.requiresPublicationUpgrade, true);
  assert.deepEqual(
    {
      ...pulled.snapshot,
      entities: [...pulled.snapshot.entities].sort((first, second) =>
        first.key < second.key ? -1 : first.key > second.key ? 1 : 0,
      ),
    },
    expectedSnapshot,
  );
  assert.deepEqual(state.conflicts, fixture.conflicts);
  const restoredPdf = await repository.downloadPdf(
    pulled.snapshot.pdfs[0],
    new AbortController().signal,
  );
  assert.equal(await restoredPdf.blob.text(), await fixture.pdf.blob.text());

  const { createServer } = await import('vite');
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    const { BrowserSyncLocalAdapter, validatedDocumentState } =
      (await server.ssrLoadModule(
        '/src/sync/localAdapter.ts',
      )) as typeof import('../src/sync/localAdapter.ts');
    assert.doesNotThrow(() =>
      new BrowserSyncLocalAdapter().validateSnapshot(pulled.snapshot),
    );
    const legacyDocumentRecords = pulled.snapshot.entities.filter(
      (item) =>
        (item.kind === 'document' ? item.id : item.documentId) ===
        fixture.pdf.documentId,
    );
    const upgradedLegacyState = validatedDocumentState(
      fixture.pdf.documentId,
      legacyDocumentRecords,
    );
    assert.equal(upgradedLegacyState.schemaVersion, 8);
    assert.equal(upgradedLegacyState.documentType, 'pdf');
    assert.equal(upgradedLegacyState.annotations.length, 2);
    assert.equal(upgradedLegacyState.officeAnnotations.length, 0);
    assert.deepEqual(
      upgradedLegacyState.readingPosition,
      legacyDocumentRecords.find((item) => item.kind === 'reading-position')?.value,
    );
    assert.equal(upgradedLegacyState.documentReadingPosition, undefined);

    const currentWithoutDocumentType = legacyDocumentRecords.map((item) =>
      item.kind === 'document'
        ? {
            ...item,
            value: { ...(item.value as Record<string, unknown>), schemaVersion: 8 },
          }
        : item,
    );
    delete (
      currentWithoutDocumentType.find((item) => item.kind === 'document')?.value as {
        documentType?: unknown;
      }
    ).documentType;
    assert.throws(
      () => validatedDocumentState(fixture.pdf.documentId, currentWithoutDocumentType),
      /failed validation/u,
    );
  } finally {
    await server.close();
  }

  const preservedKinds = new Set(pulled.snapshot.entities.map((item) => item.kind));
  assert.deepEqual(
    preservedKinds,
    new Set([
      'document',
      'annotation',
      'note-anchor',
      'note',
      'glossary',
      'reading-position',
      'collection',
      'tag',
      'print-draft',
      'ai-conversation',
      'ai-configuration',
      'prompt-profile',
      'default-prompt',
    ]),
  );
  assert.equal(
    pulled.snapshot.entities.filter((item) => item.kind === 'annotation').length,
    2,
  );
  assert.equal(pulled.snapshot.tombstones.length, 1);
  assert.deepEqual(
    Object.fromEntries(
      pulled.snapshot.entities.map((item) => [item.key, item.version]),
    ),
    Object.fromEntries(
      fixture.snapshot.entities.map((item) => [item.key, item.version]),
    ),
  );

  drive.operations.length = 0;
  const pushed = await repository.push(
    pulled.snapshot,
    [fixture.pdf],
    state,
    new AbortController().signal,
  );
  const upgradedManifest = await drive.readManifest();
  assert.equal(upgradedManifest.payloadStorage, 'immutable-v1');
  assert.equal(upgradedManifest.manifestStorage, IMMUTABLE_MANIFEST_STORAGE);
  assert.ok(isImmutableCloudManifest(upgradedManifest));
  assert.equal(upgradedManifest.generation.legacySources.length, 1);
  assert.equal(await verifyCloudManifestGeneration(upgradedManifest), true);
  assert.equal(pushed.pdfsUploaded, 0);
  assert.equal(
    upgradedManifest.documents[0].pdf?.fileId,
    legacy.manifest.documents[0].pdf?.fileId,
  );
  for (const [fileId, bytes] of legacyBytes) {
    assert.ok(drive.files.has(fileId));
    assert.equal(drive.files.get(fileId)?.content, bytes);
    assert.equal(drive.files.get(fileId)?.trashed, undefined);
  }
  assert.deepEqual(state.conflicts, fixture.conflicts);
  for (const reference of [
    upgradedManifest.library,
    upgradedManifest.aiSettings,
    ...upgradedManifest.documents.flatMap((document) => [
      document.state,
      ...(document.productivity ? [document.productivity] : []),
    ]),
  ]) {
    assert.match(
      drive.files.get(reference.fileId)?.name ?? '',
      /-[a-f0-9]{16}\.json$/u,
    );
    assert.equal(
      await sha256Hex(await drive.downloadBlob(reference.fileId)),
      reference.sha256,
    );
  }
  const freshRepository = new GoogleDriveSyncRepository(drive.asClient());
  const freshState = deviceState();
  const repulled = await freshRepository.pull(freshState, new AbortController().signal);
  assert.equal(repulled.requiresPublicationUpgrade, false);
  assert.deepEqual(repulled.snapshot, pushed.snapshot);
  drive.operations.length = 0;
  const repeated = await freshRepository.pull(freshState, new AbortController().signal);
  assert.equal(repeated.requiresPublicationUpgrade, false);
  assert.deepEqual(repeated.snapshot, pushed.snapshot);
  assert.deepEqual(drive.operations, []);
});

test('legacy migration interruption keeps old data authoritative and retry reuses verified generations', async () => {
  const drive = new InMemoryDrive();
  const fixture = await comprehensiveLegacyFixture();
  const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
  const originalManifestText = await drive.downloadText(legacy.manifestFile.id);
  const legacyBytes = new Map(
    legacy.legacyFileIds.map((fileId) => [fileId, drive.files.get(fileId)?.content]),
  );
  const state = deviceState();
  state.conflicts = structuredClone(fixture.conflicts);
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  const pulled = await repository.pull(state, new AbortController().signal);
  drive.beforeUpload = async ({ metadata }) => {
    if (metadata?.appProperties?.role === 'manifest-generation') {
      throw new Error('Simulated migration interruption before manifest publication.');
    }
  };
  await assert.rejects(
    () =>
      repository.push(
        pulled.snapshot,
        [fixture.pdf],
        state,
        new AbortController().signal,
      ),
    /migration interruption/u,
  );
  assert.equal(await drive.downloadText(legacy.manifestFile.id), originalManifestText);
  assert.equal(drive.manifestGenerations().length, 0);
  assert.equal(
    (await drive.readManifestGeneration(legacy.manifestFile)).payloadStorage,
    undefined,
  );
  for (const [fileId, bytes] of legacyBytes) {
    assert.ok(drive.files.has(fileId));
    assert.equal(drive.files.get(fileId)?.content, bytes);
  }
  assert.equal(
    [...drive.files.values()].filter((file) => /-[a-f0-9]{16}\.json$/u.test(file.name))
      .length,
    4,
  );
  assert.deepEqual(state.conflicts, fixture.conflicts);

  drive.beforeUpload = undefined;
  drive.operations.length = 0;
  await repository.push(
    pulled.snapshot,
    [fixture.pdf],
    state,
    new AbortController().signal,
  );
  const migrated = await drive.readManifest();
  assert.equal(migrated.payloadStorage, 'immutable-v1');
  assert.equal(migrated.manifestStorage, IMMUTABLE_MANIFEST_STORAGE);
  assert.ok(isImmutableCloudManifest(migrated));
  assert.equal(
    drive.operations.some(
      (operation) =>
        operation.startsWith('upload:commit:') &&
        /-[a-f0-9]{16}\.json$/u.test(operation),
    ),
    false,
  );
  assert.equal(
    drive.operations.filter((operation) => operation.startsWith('update:')).length,
    0,
  );
  assert.equal(
    drive.operations.filter((operation) =>
      /^upload:commit:39note-manifest-v1-[a-f0-9]{64}\.json$/u.test(operation),
    ).length,
    1,
  );
  for (const fileId of legacy.legacyFileIds) assert.ok(drive.files.has(fileId));
  assert.deepEqual(state.conflicts, fixture.conflicts);
});

test('cloud PDF download verifies bytes before restoring the original Blob', async () => {
  const blob = new Blob(['%PDF-1.4\nverified\n%%EOF'], { type: 'application/pdf' });
  const descriptor = {
    documentId: 'doc-1',
    fileName: 'verified.pdf',
    mimeType: 'application/pdf',
    size: blob.size,
    lastModified: 1,
    storedAt: 2,
    sha256: await sha256Hex(blob),
    fileId: 'pdf-1',
  };
  const repository = new GoogleDriveSyncRepository({
    async downloadBlob() {
      return blob;
    },
  } as unknown as DriveClient);
  const restored = await repository.downloadPdf(
    descriptor,
    new AbortController().signal,
  );
  assert.equal(restored.blob, blob);
  await assert.rejects(
    () =>
      repository.downloadPdf(
        { ...descriptor, sha256: 'f'.repeat(64) },
        new AbortController().signal,
      ),
    /integrity check/,
  );
});

test('a cached Drive folder survives a user rename without creating a duplicate root', async () => {
  let createCalls = 0;
  const listQueries: string[] = [];
  const fakeDrive = {
    async getMetadata() {
      return {
        id: 'root-renamed',
        name: 'My renamed study archive',
        mimeType: 'application/vnd.google-apps.folder',
      };
    },
    async listFiles(query: string) {
      listQueries.push(query);
      return query.includes("role' and value='root")
        ? [
            {
              id: 'root-renamed',
              name: 'My renamed study archive',
              mimeType: 'application/vnd.google-apps.folder',
              appProperties: { application: '39Note', role: 'root' },
            },
          ]
        : [];
    },
    async createFolder() {
      createCalls += 1;
      throw new Error('A replacement root must not be created for a rename.');
    },
  } as unknown as DriveClient;
  const state = deviceState();
  state.driveFiles.rootFolderId = 'root-renamed';
  const repository = new GoogleDriveSyncRepository(fakeDrive);
  const pulled = await repository.pull(state, new AbortController().signal);
  assert.equal(pulled.rootFolderId, 'root-renamed');
  assert.equal(
    repository.getRootFolderUrl(),
    'https://drive.google.com/drive/folders/root-renamed',
  );
  assert.equal(createCalls, 0);
  assert.equal(
    listQueries.filter((query) => query.includes("role' and value='root")).length,
    1,
  );
});

test('a cached app-owned root is rejected when ongoing discovery finds a duplicate root', async () => {
  const drive = new InMemoryDrive();
  const first = await drive.createFolder('39Note', null, {
    application: '39Note',
    role: 'root',
  });
  const second = await drive.createFolder('39Note', null, {
    application: '39Note',
    role: 'root',
  });
  const state = deviceState();
  state.driveFiles.rootFolderId = first.id;

  await assert.rejects(
    () =>
      new GoogleDriveSyncRepository(drive.asClient()).pull(
        state,
        new AbortController().signal,
      ),
    (error: unknown) =>
      error instanceof MultipleDriveRootsError &&
      new Set(error.roots.map((root) => root.id)).size === 2 &&
      error.roots.some((root) => root.id === first.id) &&
      error.roots.some((root) => root.id === second.id),
  );
  assert.equal(
    drive.listQueries.filter((query) => query.includes("role' and value='root")).length,
    1,
  );
  assert.equal(
    drive.operations.some((operation) => operation.includes('39note-manifest.json')),
    false,
  );
});

test('a duplicate root injected during initial creation is rejected post-create', async () => {
  const drive = new InMemoryDrive();
  let duplicateInjected = false;
  drive.afterCreateFolder = async (folder) => {
    if (folder.appProperties?.role !== 'root' || duplicateInjected) return;
    duplicateInjected = true;
    drive.afterCreateFolder = undefined;
    await drive.createFolder('39Note', null, {
      application: '39Note',
      role: 'root',
    });
  };
  const state = deviceState();

  await assert.rejects(
    () =>
      new GoogleDriveSyncRepository(drive.asClient()).pull(
        state,
        new AbortController().signal,
      ),
    (error: unknown) =>
      error instanceof MultipleDriveRootsError && error.roots.length === 2,
  );
  assert.equal(duplicateInjected, true);
  assert.equal(drive.findByRole('root').length, 2);
  assert.equal(state.driveFiles.rootFolderId, undefined);
  assert.equal(
    drive.operations.some((operation) => operation.includes('39note-manifest.json')),
    false,
  );
});

test('a trashed cached root is reported and never replaced without user confirmation', async () => {
  let createCalls = 0;
  const fakeDrive = {
    async getMetadata() {
      return {
        id: 'root-trashed',
        name: '39Note',
        mimeType: 'application/vnd.google-apps.folder',
        trashed: true,
      };
    },
    async createFolder() {
      createCalls += 1;
    },
  } as unknown as DriveClient;
  const state = deviceState();
  state.driveFiles.rootFolderId = 'root-trashed';
  await assert.rejects(
    () =>
      new GoogleDriveSyncRepository(fakeDrive).pull(
        state,
        new AbortController().signal,
      ),
    DriveRootUnavailableError,
  );
  assert.equal(createCalls, 0);
});

test('immutable manifest-generation coordination is create-only, convergent, and fail-safe', async (context) => {
  await context.test(
    'initial publication creates one content-addressed generation and reload discovers it',
    async () => {
      const drive = new InMemoryDrive();
      const original = {
        ...studySnapshot('Initial immutable note', 2, 'device-a'),
        generatedAt: 2,
      };
      let payloadsVerifiedBeforeManifestCreation = false;
      drive.beforeUpload = async ({ content, metadata }) => {
        if (metadata?.appProperties?.role !== 'manifest-generation') return;
        const candidate = parseCloudManifest(await content.text());
        const references = [
          candidate.library,
          candidate.aiSettings,
          ...candidate.documents.flatMap((document) => [
            document.state,
            ...(document.productivity ? [document.productivity] : []),
          ]),
        ];
        payloadsVerifiedBeforeManifestCreation = references.every(
          (reference) => (drive.blobDownloadCount.get(reference.fileId) ?? 0) > 0,
        );
      };
      const seeded = await seedMemoryDrive(drive, original);
      assert.equal(payloadsVerifiedBeforeManifestCreation, true);
      const generations = await readManifestGenerations(drive);
      assert.equal(generations.length, 1);
      const published = generations[0].manifest;
      assert.equal(published.payloadStorage, 'immutable-v1');
      assert.equal(published.manifestStorage, IMMUTABLE_MANIFEST_STORAGE);
      assert.deepEqual(published.generation.parents, []);
      assert.deepEqual(published.generation.legacySources, []);
      assert.equal(published.generation.createdBy, 'device-a');
      assert.equal(await verifyCloudManifestGeneration(published), true);
      assert.equal(
        generations[0].file.name,
        `39note-manifest-v1-${published.generation.id}.json`,
      );
      assert.equal(
        generations[0].file.appProperties?.generationId,
        published.generation.id,
      );
      assert.notEqual(published.generation.id, generations[0].file.version);
      assert.equal(
        drive.findByRole('manifest').length,
        0,
        'new publication must not use the reserved mutable manifest role',
      );
      assert.deepEqual(
        drive.mutations
          .filter((mutation) => mutation.role === 'manifest-generation')
          .map((mutation) => [mutation.method, mutation.operation]),
        [['POST', 'create-file']],
      );

      const reloaded = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        structuredClone(seeded.state),
        new AbortController().signal,
      );
      assert.deepEqual(reloaded.snapshot, original);
      assert.equal(reloaded.requiresPublicationUpgrade, false);
      assert.equal(reloaded.manifestVersion, published.generation.id);
    },
  );

  await context.test(
    'concurrent heads remain intact, preserve Note conflict evidence, and merge deterministically',
    async () => {
      const drive = new InMemoryDrive();
      const baseSnapshot = {
        ...studySnapshot('Base note', 2, 'device-base'),
        generatedAt: 2,
      };
      await seedMemoryDrive(drive, baseSnapshot);
      const base = (await readManifestGenerations(drive))[0];
      const branchA = await uploadStateBranch(drive, base.manifest, {
        ...studySnapshot('Concurrent note A', 10, 'device-a'),
        generatedAt: 10,
      });
      const branchB = await uploadStateBranch(drive, base.manifest, {
        ...studySnapshot('Concurrent note B', 11, 'device-b'),
        generatedAt: 11,
      });
      const branchBytes = new Map([
        [branchA.file.id, await drive.downloadText(branchA.file.id)],
        [branchB.file.id, await drive.downloadText(branchB.file.id)],
      ]);
      assert.deepEqual(
        logicalManifestHeads(await readManifestGenerations(drive)).map(
          (manifest) => manifest.generation.id,
        ),
        [branchA.manifest.generation.id, branchB.manifest.generation.id].sort(),
      );

      const state = deviceState();
      state.deviceId = 'device-c';
      const repository = new GoogleDriveSyncRepository(drive.asClient());
      const pulled = await repository.pull(state, new AbortController().signal);
      assert.equal(pulled.requiresPublicationUpgrade, true);
      assert.equal(pulled.conflicts?.length, 1);
      const winningNote = pulled.snapshot.entities.find(
        (entityValue) => entityValue.kind === 'note',
      );
      assert.deepEqual(winningNote?.value, { content: 'Concurrent note B' });
      assert.deepEqual(pulled.conflicts?.[0].alternateValue, {
        content: 'Concurrent note A',
      });

      state.conflicts = structuredClone(pulled.conflicts ?? []);
      const merged = await repository.push(
        pulled.snapshot,
        [],
        state,
        new AbortController().signal,
      );
      const afterMerge = await readManifestGenerations(drive);
      const heads = logicalManifestHeads(afterMerge);
      assert.equal(heads.length, 1);
      assert.equal(heads[0].generation.id, merged.manifestVersion);
      assert.deepEqual(
        heads[0].generation.parents,
        [branchA.manifest.generation.id, branchB.manifest.generation.id].sort(),
      );
      assert.equal(heads[0].conflicts.length, 1);
      for (const [fileId, bytes] of branchBytes) {
        assert.equal(await drive.downloadText(fileId), bytes);
      }

      const fileCount = drive.files.size;
      const finalPull = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.equal(finalPull.requiresPublicationUpgrade, false);
      assert.deepEqual(finalPull.snapshot, merged.snapshot);
      assert.equal(drive.files.size, fileCount);
    },
  );

  await context.test(
    'a newer tombstone from one head suppresses a stale entity in another',
    async () => {
      const drive = new InMemoryDrive();
      const baseSnapshot = {
        ...studySnapshot('Base note', 2, 'device-base'),
        generatedAt: 2,
      };
      await seedMemoryDrive(drive, baseSnapshot);
      const base = (await readManifestGenerations(drive))[0].manifest;
      const noteKey = baseSnapshot.entities.find((item) => item.kind === 'note')?.key;
      assert.ok(noteKey);
      await uploadStateBranch(drive, base, {
        ...studySnapshot('Stale edit', 5, 'device-a'),
        generatedAt: 5,
      });
      await uploadStateBranch(
        drive,
        base,
        createTombstoneSnapshot(baseSnapshot, noteKey, 9, 'device-b'),
      );

      const pulled = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.equal(
        pulled.snapshot.entities.some((item) => item.key === noteKey),
        false,
      );
      assert.equal(
        pulled.snapshot.tombstones.some((item) => item.key === noteKey),
        true,
      );
    },
  );

  await context.test(
    'interrupted payload or manifest creation leaves existing heads authoritative and keeps orphans harmless',
    async () => {
      const drive = new InMemoryDrive();
      const baseSnapshot = {
        ...studySnapshot('Published base', 2, 'device-a'),
        generatedAt: 2,
      };
      const seeded = await seedMemoryDrive(drive, baseSnapshot);
      const originalHead = (await readManifestGenerations(drive))[0];
      const changed = {
        ...studySnapshot('Interrupted edit', 3, 'device-a'),
        generatedAt: 3,
      };

      drive.beforeUpload = ({ metadata }) => {
        if (metadata?.appProperties?.role === 'state') {
          throw new Error('Simulated payload interruption.');
        }
      };
      await assert.rejects(
        () =>
          seeded.repository.push(
            changed,
            [],
            seeded.state,
            new AbortController().signal,
          ),
        /payload interruption/u,
      );
      assert.deepEqual(
        logicalManifestHeads(await readManifestGenerations(drive)).map(
          (manifest) => manifest.generation.id,
        ),
        [originalHead.manifest.generation.id],
      );

      drive.beforeUpload = ({ metadata }) => {
        if (metadata?.appProperties?.role === 'manifest-generation') {
          throw new Error('Simulated manifest interruption.');
        }
      };
      await assert.rejects(
        () =>
          seeded.repository.push(
            changed,
            [],
            seeded.state,
            new AbortController().signal,
          ),
        /manifest interruption/u,
      );
      assert.equal(
        drive.findByRole('state').length,
        2,
        'verified payload orphan is retained',
      );
      assert.equal(drive.manifestGenerations().length, 1);
      const pulled = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.deepEqual(pulled.snapshot, baseSnapshot);

      drive.beforeUpload = undefined;
      await seeded.repository.push(
        changed,
        [],
        seeded.state,
        new AbortController().signal,
      );
      assert.equal(
        drive.findByRole('state').length,
        2,
        'retry reuses the verified orphan',
      );
      assert.equal(
        logicalManifestHeads(await readManifestGenerations(drive)).length,
        1,
      );
    },
  );

  await context.test(
    'incomplete/orphan generations are ignored and duplicate logical/list results are deduplicated',
    async () => {
      const drive = new InMemoryDrive();
      const original = {
        ...studySnapshot('Valid head', 2, 'device-a'),
        generatedAt: 2,
      };
      await seedMemoryDrive(drive, original);
      const valid = (await readManifestGenerations(drive))[0];
      await drive.uploadFile(
        `39note-manifest-v1-${'0'.repeat(64)}.json`,
        new Blob(['{"incomplete":true}'], { type: 'application/json' }),
        {
          parents: [drive.findByRole('root')[0].id],
          appProperties: {
            application: '39Note',
            role: 'manifest-generation',
            manifestStorage: IMMUTABLE_MANIFEST_STORAGE,
            generationId: '0'.repeat(64),
          },
        },
      );
      await uploadManifestGeneration(drive, valid.manifest, {
        createdAt: 3,
        createdBy: 'orphan-child',
        parents: ['f'.repeat(64)],
      });
      const duplicate = await drive.uploadFile(
        valid.file.name,
        valid.file.content as Blob,
        {
          parents: [...(valid.file.parents ?? [])],
          appProperties: { ...(valid.file.appProperties ?? {}) },
        },
      );
      drive.duplicateManifestListResults = true;

      const pulled = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.deepEqual(pulled.snapshot, original);
      assert.equal(pulled.requiresPublicationUpgrade, false);
      assert.equal(drive.manifestGenerations().length, 4);
      assert.ok(drive.files.has(duplicate.id));
    },
  );

  await context.test(
    'three no-store discovery passes absorb a delayed/stale listing',
    async () => {
      const drive = new InMemoryDrive();
      const original = {
        ...studySnapshot('Old visible head', 2, 'device-a'),
        generatedAt: 2,
      };
      await seedMemoryDrive(drive, original);
      const base = (await readManifestGenerations(drive))[0];
      const delayedSnapshot = {
        ...studySnapshot('Delayed visible head', 3, 'device-b'),
        generatedAt: 3,
      };
      const delayed = await uploadStateBranch(drive, base.manifest, delayedSnapshot);
      drive.queueManifestListSnapshot([base.file]);
      drive.queueManifestListSnapshot([base.file]);
      drive.queueManifestListSnapshot([base.file, delayed.file]);

      const pulled = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.deepEqual(pulled.snapshot, delayedSnapshot);
      assert.equal(pulled.manifestVersion, delayed.manifest.generation.id);
      const discoveryQueries = drive.listQueries.filter((query) =>
        query.includes("role' and value='manifest-generation"),
      );
      assert.ok(discoveryQueries.length >= 3);
    },
  );

  await context.test(
    'each discovery pass exhausts pagination before deriving the valid head',
    async () => {
      const drive = new InMemoryDrive();
      const original = {
        ...studySnapshot('First-page ancestor', 2, 'device-a'),
        generatedAt: 2,
      };
      const seeded = await seedMemoryDrive(drive, original);
      const ancestor = drive.manifestGenerations()[0];
      const latestSnapshot = {
        ...studySnapshot('Second-page valid head', 3, 'device-a'),
        generatedAt: 3,
      };
      const pushed = await seeded.repository.push(
        latestSnapshot,
        [],
        seeded.state,
        new AbortController().signal,
      );
      const latest = drive
        .manifestGenerations()
        .find((file) => file.appProperties?.generationId === pushed.manifestVersion);
      const root = drive.findByRole('root')[0];
      assert.ok(latest);

      const metadata = (file: MemoryDriveFile): DriveFileMetadata => {
        const copy = structuredClone(file);
        Reflect.deleteProperty(copy, 'content');
        return copy;
      };
      const manifestPageRequests: Array<{
        pageToken: string | null;
        cache: RequestCache | undefined;
      }> = [];
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/drive/v3/files') {
          const query = url.searchParams.get('q') ?? '';
          if (query.includes("role' and value='manifest-generation")) {
            const pageToken = url.searchParams.get('pageToken');
            manifestPageRequests.push({ pageToken, cache: init?.cache });
            return pageToken
              ? Response.json({ files: [metadata(latest)] })
              : Response.json({
                  files: [metadata(ancestor)],
                  nextPageToken: 'manifest-page-2',
                });
          }
          if (query.includes("role' and value='root")) {
            return Response.json({ files: [metadata(root)] });
          }
          if (query.includes("name='39note-manifest.json'")) {
            return Response.json({ files: [] });
          }
          return Response.json({ files: [] });
        }

        const fileId = decodeURIComponent(
          url.pathname.slice('/drive/v3/files/'.length),
        );
        const file = drive.files.get(fileId);
        if (!file) {
          return Response.json(
            { error: { message: 'missing fixture file' } },
            {
              status: 404,
            },
          );
        }
        if (url.searchParams.get('alt') === 'media') {
          return new Response(file.content);
        }
        return Response.json(metadata(file));
      }) as typeof fetch;

      try {
        const state = deviceState();
        state.driveFiles.rootFolderId = root.id;
        const pulled = await new GoogleDriveSyncRepository(
          new DriveClient(() => 'fake-google-oauth-token'),
        ).pull(state, new AbortController().signal);
        assert.deepEqual(pulled.snapshot, latestSnapshot);
        assert.equal(pulled.manifestVersion, pushed.manifestVersion);
        assert.equal(pulled.requiresPublicationUpgrade, false);
      } finally {
        globalThis.fetch = previousFetch;
      }

      assert.deepEqual(
        manifestPageRequests.map((request) => request.pageToken),
        [null, 'manifest-page-2', null, 'manifest-page-2', null, 'manifest-page-2'],
      );
      assert.ok(manifestPageRequests.every((request) => request.cache === 'no-store'));
    },
  );

  await context.test(
    'a Note-only child generation performs zero PDF reuploads',
    async () => {
      const drive = new InMemoryDrive();
      const pdfBlob = new Blob(['%PDF-1.4\nnote-only\n%%EOF'], {
        type: 'application/pdf',
      });
      const pdf: LocalSyncPdf = {
        documentId: 'doc-1',
        fileName: 'study.pdf',
        mimeType: 'application/pdf',
        size: pdfBlob.size,
        lastModified: 1,
        storedAt: 2,
        sha256: await sha256Hex(pdfBlob),
        blob: pdfBlob,
      };
      const initial = {
        ...studySnapshot('Before edit', 2, 'device-a'),
        generatedAt: 2,
        pdfs: [
          {
            documentId: pdf.documentId,
            fileName: pdf.fileName,
            mimeType: pdf.mimeType,
            size: pdf.size,
            lastModified: pdf.lastModified,
            storedAt: pdf.storedAt,
            sha256: pdf.sha256,
          },
        ],
      };
      const seeded = await seedMemoryDrive(drive, initial, [pdf]);
      const pdfUploadsBefore = drive.mutations.filter(
        (mutation) => mutation.role === 'original-pdf',
      ).length;
      await seeded.repository.push(
        {
          ...studySnapshot('After Note edit', 3, 'device-a'),
          generatedAt: 3,
          pdfs: seeded.state.remoteSnapshot?.pdfs ?? initial.pdfs,
        },
        [pdf],
        seeded.state,
        new AbortController().signal,
      );
      assert.equal(
        drive.mutations.filter((mutation) => mutation.role === 'original-pdf').length,
        pdfUploadsBefore,
      );
      assert.equal(drive.findByRole('original-pdf').length, 1);
    },
  );

  await context.test(
    'legacy immutable-v1 payload storage migrates once while retaining the legacy manifest and payloads',
    async () => {
      const drive = new InMemoryDrive();
      const original = {
        ...studySnapshot('Legacy immutable payloads', 2, 'device-a'),
        generatedAt: 2,
      };
      await seedMemoryDrive(drive, original);
      const seededGeneration = (await readManifestGenerations(drive))[0];
      const legacy: CloudSyncManifest = structuredClone(seededGeneration.manifest);
      delete legacy.manifestStorage;
      delete legacy.generation;
      drive.files.delete(seededGeneration.file.id);
      const legacyFile = await drive.uploadFile(
        '39note-manifest.json',
        new Blob([stableStringify(legacy)], { type: 'application/json' }),
        {
          parents: [drive.findByRole('root')[0].id],
          appProperties: { application: '39Note', syncSchema: '1', role: 'manifest' },
        },
      );
      const legacyText = await drive.downloadText(legacyFile.id);
      const payloadIds = [
        legacy.library.fileId,
        legacy.aiSettings.fileId,
        ...legacy.documents.flatMap((document) => [
          document.state.fileId,
          ...(document.productivity ? [document.productivity.fileId] : []),
        ]),
      ];
      const state = deviceState();
      const repository = new GoogleDriveSyncRepository(drive.asClient());
      const pulled = await repository.pull(state, new AbortController().signal);
      assert.equal(pulled.requiresPublicationUpgrade, true);
      await repository.push(pulled.snapshot, [], state, new AbortController().signal);
      assert.equal(await drive.downloadText(legacyFile.id), legacyText);
      for (const fileId of payloadIds) assert.ok(drive.files.has(fileId));
      const migrated = logicalManifestHeads(await readManifestGenerations(drive));
      assert.equal(migrated.length, 1);
      assert.equal(migrated[0].generation.legacySources.length, 1);

      const mutationCount = drive.mutations.length;
      const reloaded = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.equal(reloaded.requiresPublicationUpgrade, false);
      assert.deepEqual(reloaded.snapshot, pulled.snapshot);
      assert.equal(drive.mutations.length, mutationCount);
    },
  );
});

test('immutable integrity failures remain fail-closed unless an exact recovery child covers them', async (context) => {
  await context.test(
    'a corrupt concurrent head is not hidden by another valid head',
    async () => {
      const drive = new InMemoryDrive();
      const baseSnapshot = {
        ...studySnapshot('Shared base', 2, 'device-base'),
        generatedAt: 2,
      };
      await seedMemoryDrive(drive, baseSnapshot);
      const base = (await readManifestGenerations(drive))[0].manifest;
      const branchA = await uploadStateBranch(drive, base, {
        ...studySnapshot('Branch A', 10, 'device-a'),
        generatedAt: 10,
      });
      await uploadStateBranch(drive, base, {
        ...studySnapshot('Branch B remains valid', 11, 'device-b'),
        generatedAt: 11,
      });
      const alternate = {
        ...studySnapshot('Valid bytes under the wrong hash', 12, 'device-z'),
        generatedAt: 12,
      };
      await replaceImmutableStateWithValidAlternate(drive, branchA.manifest, alternate);

      const failure = await expectIntegrityFailure(
        new GoogleDriveSyncRepository(drive.asClient()),
        deviceState(),
      );
      assert.equal(failure.manifestSourceId, branchA.manifest.generation.id);
      assert.equal(failure.diagnostic.actualPayloadValid, true);
    },
  );

  await context.test(
    'a missing payload in one concurrent head is not hidden by another valid head',
    async () => {
      const drive = new InMemoryDrive();
      const baseSnapshot = {
        ...studySnapshot('Shared base', 2, 'device-base'),
        generatedAt: 2,
      };
      await seedMemoryDrive(drive, baseSnapshot);
      const base = (await readManifestGenerations(drive))[0].manifest;
      const branchA = await uploadStateBranch(drive, base, {
        ...studySnapshot('Branch with missing bytes', 10, 'device-a'),
        generatedAt: 10,
      });
      await uploadStateBranch(drive, base, {
        ...studySnapshot('Valid sibling branch', 11, 'device-b'),
        generatedAt: 11,
      });
      const missingFileId = branchA.manifest.documents[0].state.fileId;
      assert.equal(drive.files.delete(missingFileId), true);

      await assert.rejects(
        () =>
          new GoogleDriveSyncRepository(drive.asClient()).pull(
            deviceState(),
            new AbortController().signal,
          ),
        /references a missing payload generation/u,
      );
    },
  );

  await context.test(
    'an exact immutable recovery child preserves the corrupt parent and restores refresh',
    async () => {
      const drive = new InMemoryDrive();
      const localSnapshot = {
        ...studySnapshot('Expected local candidate A', 10, 'device-a'),
        generatedAt: 10,
      };
      await seedMemoryDrive(drive, localSnapshot);
      const parent = (await readManifestGenerations(drive))[0];
      const parentBytes = await drive.downloadText(parent.file.id);
      const remoteSnapshot = {
        ...studySnapshot('Observed remote candidate B', 11, 'device-b'),
        generatedAt: 11,
      };
      const mismatch = await replaceImmutableStateWithValidAlternate(
        drive,
        parent.manifest,
        remoteSnapshot,
      );
      const failedPayloadBytes = await drive.downloadText(mismatch.expected.fileId);
      const existingFileIds = new Set(drive.files.keys());
      const state = deviceState();
      state.deviceId = 'recovery-device';
      const repository = new GoogleDriveSyncRepository(drive.asClient());
      const failure = await expectIntegrityFailure(repository, state);

      const conflicts = await repository.repairFromValidRemoteGeneration(
        failure,
        localSnapshot,
        state,
        new AbortController().signal,
      );
      assert.equal(conflicts.length, 1);
      for (const fileId of existingFileIds) assert.ok(drive.files.has(fileId));
      assert.equal(await drive.downloadText(parent.file.id), parentBytes);
      assert.equal(
        await drive.downloadText(mismatch.expected.fileId),
        failedPayloadBytes,
      );

      const generations = await readManifestGenerations(drive);
      const child = generations.find(
        ({ manifest }) =>
          manifest.generation.parents.length === 1 &&
          manifest.generation.parents[0] === parent.manifest.generation.id,
      );
      assert.ok(child);
      assert.equal(child.manifest.recoveryEvidence?.length, 1);
      assert.equal(
        child.manifest.recoveryEvidence?.[0].sourceManifestId,
        parent.manifest.generation.id,
      );
      assert.equal(
        child.manifest.recoveryEvidence?.[0].expected.sha256,
        mismatch.expected.sha256,
      );
      assert.equal(
        child.manifest.recoveryEvidence?.[0].observed?.sha256,
        mismatch.alternate.sha256,
      );
      assert.deepEqual(
        child.manifest.recoveryEvidence?.[0].merged,
        child.manifest.documents[0].state,
      );
      assert.equal(
        drive.mutations.some(
          (mutation) =>
            mutation.role === 'manifest-generation' && mutation.method !== 'POST',
        ),
        false,
      );

      const refreshed = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.equal(refreshed.requiresPublicationUpgrade, false);
      assert.ok(
        refreshed.snapshot.entities.some(
          (item) =>
            item.kind === 'note' &&
            (item.value as { content?: string }).content ===
              'Observed remote candidate B',
        ),
      );
      assert.equal(refreshed.conflicts?.length, 1);
    },
  );

  await context.test(
    'a recovery-looking child with the wrong source identity cannot suppress corruption',
    async () => {
      const drive = new InMemoryDrive();
      const expectedSnapshot = {
        ...studySnapshot('Expected A', 10, 'device-a'),
        generatedAt: 10,
      };
      await seedMemoryDrive(drive, expectedSnapshot);
      const parent = (await readManifestGenerations(drive))[0].manifest;
      const observedSnapshot = {
        ...studySnapshot('Observed B', 11, 'device-b'),
        generatedAt: 11,
      };
      const mismatch = await replaceImmutableStateWithValidAlternate(
        drive,
        parent,
        observedSnapshot,
      );
      const childState = await createMemoryStateGeneration(
        drive,
        parent,
        observedSnapshot,
      );
      const childReference = childState.manifest.documents[0].state;
      await uploadManifestGeneration(
        drive,
        {
          ...childState.manifest,
          conflicts: [],
          recoveryEvidence: [
            {
              sourceManifestId: 'f'.repeat(64),
              logicalType: 'state',
              documentId: 'doc-1',
              expected: mismatch.expected,
              observed: childReference,
              merged: childReference,
            },
          ],
        },
        {
          createdAt: 12,
          createdBy: 'malicious-or-buggy-recovery',
          parents: [parent.generation.id],
        },
      );

      const failure = await expectIntegrityFailure(
        new GoogleDriveSyncRepository(drive.asClient()),
        deviceState(),
      );
      assert.equal(failure.manifestSourceId, parent.generation.id);
      assert.equal(failure.expectedHash, mismatch.expected.sha256);
      assert.equal(failure.actualHash, mismatch.alternate.sha256);
    },
  );
});

test('legacy state remains a virtual head until its exact revision is incorporated', async (context) => {
  await context.test(
    'an unchanged incorporated legacy revision is ignored while one later revision merges exactly once',
    async () => {
      const drive = new InMemoryDrive();
      const fixture = await comprehensiveLegacyFixture();
      const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
      const migrationState = deviceState();
      const migrationRepository = new GoogleDriveSyncRepository(drive.asClient());
      const legacyPull = await migrationRepository.pull(
        migrationState,
        new AbortController().signal,
      );
      await migrationRepository.push(
        legacyPull.snapshot,
        [fixture.pdf],
        migrationState,
        new AbortController().signal,
      );
      const firstHead = logicalManifestHeads(await readManifestGenerations(drive))[0];
      assert.equal(firstHead.generation.legacySources.length, 1);

      const unchangedMutationCount = drive.mutations.length;
      const unchanged = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.equal(unchanged.requiresPublicationUpgrade, false);
      assert.equal(drive.mutations.length, unchangedMutationCount);

      const externalSnapshot = structuredClone(fixture.snapshot);
      const externalNote = externalSnapshot.entities.find(
        (item) => item.kind === 'note',
      );
      assert.ok(externalNote);
      externalNote.value = {
        ...(externalNote.value as object),
        content: 'Legacy writer after immutable cutover',
      };
      externalNote.version = {
        updatedAt: externalNote.version.updatedAt + 100,
        deviceId: 'legacy-writer-b',
        hash: await sha256Hex(stableStringify(externalNote.value)),
      };
      externalSnapshot.generatedAt += 100;
      externalSnapshot.generatedBy = 'legacy-writer-b';
      const externalRevision = await writeExternalLegacyStateRevision(
        drive,
        legacy.manifestFile,
        legacy.manifest,
        externalSnapshot,
      );
      const legacyPayloadText = await drive.downloadText(externalRevision.stateFile.id);

      const state = deviceState();
      state.deviceId = 'immutable-reader-c';
      const repository = new GoogleDriveSyncRepository(drive.asClient());
      const merged = await repository.pull(state, new AbortController().signal);
      assert.equal(merged.requiresPublicationUpgrade, true);
      assert.ok(
        merged.snapshot.entities.some(
          (item) =>
            item.kind === 'note' &&
            (item.value as { content?: string }).content ===
              'Legacy writer after immutable cutover',
        ),
      );
      state.conflicts = structuredClone(merged.conflicts ?? []);
      await repository.push(
        merged.snapshot,
        [fixture.pdf],
        state,
        new AbortController().signal,
      );
      assert.equal(
        await drive.downloadText(legacy.manifestFile.id),
        externalRevision.text,
      );
      assert.equal(
        await drive.downloadText(externalRevision.stateFile.id),
        legacyPayloadText,
      );

      const generations = await readManifestGenerations(drive);
      const finalHeads = logicalManifestHeads(generations);
      assert.equal(finalHeads.length, 1);
      assert.deepEqual(finalHeads[0].generation.parents, [firstHead.generation.id]);
      assert.equal(finalHeads[0].generation.legacySources.length, 2);
      const mutationCount = drive.mutations.length;
      const stable = await new GoogleDriveSyncRepository(drive.asClient()).pull(
        deviceState(),
        new AbortController().signal,
      );
      assert.equal(stable.requiresPublicationUpgrade, false);
      assert.equal(drive.mutations.length, mutationCount);
      assert.deepEqual(
        orderedSnapshot(stable.snapshot),
        orderedSnapshot(merged.snapshot),
      );
    },
  );

  await context.test(
    'a legacy revision changing during publication aborts without modifying prior files',
    async () => {
      const drive = new InMemoryDrive();
      const fixture = await comprehensiveLegacyFixture();
      const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
      const migrationState = deviceState();
      const migrationRepository = new GoogleDriveSyncRepository(drive.asClient());
      const legacyPull = await migrationRepository.pull(
        migrationState,
        new AbortController().signal,
      );
      await migrationRepository.push(
        legacyPull.snapshot,
        [fixture.pdf],
        migrationState,
        new AbortController().signal,
      );
      const immutableHead = logicalManifestHeads(
        await readManifestGenerations(drive),
      )[0];
      const immutableHeadFile = drive
        .manifestGenerations()
        .find(
          (file) => file.appProperties?.generationId === immutableHead.generation.id,
        );
      assert.ok(immutableHeadFile);
      const immutableHeadText = await drive.downloadText(immutableHeadFile.id);

      const revisionB = structuredClone(fixture.snapshot);
      const noteB = revisionB.entities.find((item) => item.kind === 'note');
      assert.ok(noteB);
      noteB.value = { ...(noteB.value as object), content: 'Legacy revision B' };
      noteB.version = {
        updatedAt: noteB.version.updatedAt + 100,
        deviceId: 'legacy-b',
        hash: await sha256Hex(stableStringify(noteB.value)),
      };
      revisionB.generatedAt += 100;
      revisionB.generatedBy = 'legacy-b';
      const externalB = await writeExternalLegacyStateRevision(
        drive,
        legacy.manifestFile,
        legacy.manifest,
        revisionB,
      );

      const state = deviceState();
      const repository = new GoogleDriveSyncRepository(drive.asClient());
      const mergedB = await repository.pull(state, new AbortController().signal);
      assert.equal(mergedB.requiresPublicationUpgrade, true);
      const protectedIds = [
        ...legacy.legacyFileIds,
        externalB.stateFile.id,
        immutableHeadFile.id,
      ];
      const protectedBytes = new Map(
        await Promise.all(
          protectedIds.map(
            async (fileId) => [fileId, await drive.downloadText(fileId)] as const,
          ),
        ),
      );

      const revisionC = structuredClone(revisionB);
      const noteC = revisionC.entities.find((item) => item.kind === 'note');
      assert.ok(noteC);
      noteC.value = { ...(noteC.value as object), content: 'Legacy revision C' };
      noteC.version = {
        updatedAt: noteC.version.updatedAt + 1,
        deviceId: 'legacy-c',
        hash: await sha256Hex(stableStringify(noteC.value)),
      };
      revisionC.generatedAt += 1;
      revisionC.generatedBy = 'legacy-c';
      let changedDuringPublication = false;
      drive.beforeUpload = async ({ metadata }) => {
        if (
          metadata?.appProperties?.role !== 'manifest-generation' ||
          changedDuringPublication
        ) {
          return;
        }
        changedDuringPublication = true;
        await writeExternalLegacyStateRevision(
          drive,
          legacy.manifestFile,
          externalB.manifest,
          revisionC,
        );
      };

      await assert.rejects(
        () =>
          repository.push(
            mergedB.snapshot,
            [fixture.pdf],
            state,
            new AbortController().signal,
          ),
        RemoteManifestChangedError,
      );
      drive.beforeUpload = undefined;
      assert.equal(changedDuringPublication, true);
      for (const [fileId, bytes] of protectedBytes) {
        assert.equal(await drive.downloadText(fileId), bytes);
      }
      assert.equal(await drive.downloadText(immutableHeadFile.id), immutableHeadText);
      assert.equal(
        drive.mutations.some((mutation) => mutation.method === 'PATCH'),
        false,
      );
    },
  );
});

test('legacy live-integrity recovery preserves both valid generations and publishes a new immutable head', async () => {
  const drive = new InMemoryDrive();
  const fixture = await comprehensiveLegacyFixture();
  const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
  const legacyManifestText = await drive.downloadText(legacy.manifestFile.id);
  const failedReference = legacy.manifest.documents[0].state;
  const remoteSnapshot = structuredClone(fixture.snapshot);
  const remoteNote = remoteSnapshot.entities.find((item) => item.kind === 'note');
  assert.ok(remoteNote);
  remoteNote.value = {
    ...(remoteNote.value as object),
    content: 'Valid remote candidate',
  };
  remoteNote.version = {
    updatedAt: remoteNote.version.updatedAt,
    deviceId: 'legacy-device-b',
    hash: await sha256Hex(stableStringify(remoteNote.value)),
  };
  remoteSnapshot.generatedBy = 'legacy-device-b';
  const remotePayload = partitionSnapshot(remoteSnapshot).documents.get(
    remoteNote.documentId as string,
  )?.state;
  assert.ok(remotePayload);
  const remoteEncoded = await encodeCloudPayload(remotePayload);
  const failedBytes = new Blob([remoteEncoded.text], { type: 'application/json' });
  drive.setContent(failedReference.fileId, failedBytes);

  const state = deviceState();
  state.deviceId = 'recovery-device';
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  const failure = await expectIntegrityFailure(repository, state);
  assert.equal(failure.expectedHash, failedReference.sha256);
  assert.equal(failure.actualHash, remoteEncoded.sha256);
  assert.equal(failure.diagnostic.actualPayloadValid, true);
  const verified = await repository.verifyIntegrityFailureReadOnly(
    failure,
    new AbortController().signal,
  );
  assert.equal(verified.diagnostic.evidenceStable, true);
  assert.equal(verified.diagnostic.immutableManifestRecoveryAvailable, true);
  assert.equal(
    await repository.canMergeValidRemoteFromSnapshot(failure, fixture.snapshot),
    true,
  );
  const localBefore = structuredClone(fixture.snapshot);
  const legacyIds = new Set(drive.files.keys());
  const conflicts = await repository.repairFromValidRemoteGeneration(
    failure,
    fixture.snapshot,
    state,
    new AbortController().signal,
  );
  assert.deepEqual(
    fixture.snapshot,
    localBefore,
    'recovery must not mutate local data',
  );
  assert.ok(conflicts.length >= 1);
  assert.equal(await drive.downloadText(legacy.manifestFile.id), legacyManifestText);
  assert.equal(drive.files.get(failedReference.fileId)?.content, failedBytes);
  for (const fileId of legacyIds) assert.ok(drive.files.has(fileId));
  assert.equal(
    drive.mutations.some(
      (mutation) =>
        mutation.role === 'manifest-generation' && mutation.method !== 'POST',
    ),
    false,
  );

  const heads = logicalManifestHeads(await readManifestGenerations(drive));
  assert.equal(heads.length, 1);
  assert.equal(heads[0].generation.legacySources.length, 1);
  assert.equal(heads[0].recoveryEvidence?.length, 1);
  assert.equal(heads[0].recoveryEvidence?.[0].expected.sha256, failedReference.sha256);
  assert.equal(heads[0].recoveryEvidence?.[0].observed?.sha256, remoteEncoded.sha256);
  const refreshed = await new GoogleDriveSyncRepository(drive.asClient()).pull(
    deviceState(),
    new AbortController().signal,
  );
  assert.equal(refreshed.requiresPublicationUpgrade, false);
  assert.ok(
    refreshed.snapshot.entities.some(
      (item) =>
        item.kind === 'note' &&
        (item.value as { content?: string }).content === 'Valid remote candidate',
    ),
  );

  const repositoryA = new GoogleDriveSyncRepository(drive.asClient());
  const stateA = deviceState();
  const recoveredA = await repositoryA.pull(stateA, new AbortController().signal);
  stateA.conflicts = structuredClone(recoveredA.conflicts ?? []);
  const convergedEdit = structuredClone(recoveredA.snapshot);
  const convergedNote = convergedEdit.entities.find((item) => item.kind === 'note');
  assert.ok(convergedNote);
  convergedNote.value = {
    ...(convergedNote.value as object),
    content: 'Post-recovery A to B convergence',
  };
  convergedNote.version = {
    updatedAt: convergedNote.version.updatedAt + 100,
    deviceId: 'device-a',
    hash: await sha256Hex(stableStringify(convergedNote.value)),
  };
  convergedEdit.generatedAt += 100;
  convergedEdit.generatedBy = 'device-a';
  await repositoryA.push(convergedEdit, [], stateA, new AbortController().signal);
  const postRecoveryGenerations = await readManifestGenerations(drive);
  const recoveryHead = postRecoveryGenerations.find(
    ({ manifest }) => manifest.generation.parents.length === 0,
  );
  const convergenceChild = postRecoveryGenerations.find(
    ({ manifest }) => manifest.generation.parents.length === 1,
  );
  assert.ok(recoveryHead);
  assert.ok(convergenceChild);
  const onB = await new GoogleDriveSyncRepository(drive.asClient()).pull(
    deviceState(),
    new AbortController().signal,
  );
  assert.ok(
    onB.snapshot.entities.some(
      (item) =>
        item.kind === 'note' &&
        (item.value as { content?: string }).content ===
          'Post-recovery A to B convergence',
    ),
    JSON.stringify(onB.snapshot.entities.filter((item) => item.kind === 'note')),
  );
});

test('post-recovery pull revalidates the published immutable head by ID while Drive list indexing lags', async () => {
  const drive = new InMemoryDrive();
  const fixture = await comprehensiveLegacyFixture();
  const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
  const failedReference = legacy.manifest.documents[0].state;
  const remoteSnapshot = structuredClone(fixture.snapshot);
  const remoteNote = remoteSnapshot.entities.find((item) => item.kind === 'note');
  assert.ok(remoteNote);
  remoteNote.value = {
    ...(remoteNote.value as object),
    content: 'Valid recovery generation hidden from list indexing',
  };
  remoteNote.version = {
    updatedAt: remoteNote.version.updatedAt + 1,
    deviceId: 'legacy-device-b',
    hash: await sha256Hex(stableStringify(remoteNote.value)),
  };
  remoteSnapshot.generatedAt += 1;
  remoteSnapshot.generatedBy = 'legacy-device-b';
  const remotePayload = partitionSnapshot(remoteSnapshot).documents.get(
    remoteNote.documentId as string,
  )?.state;
  assert.ok(remotePayload);
  const remoteEncoded = await encodeCloudPayload(remotePayload);
  drive.setContent(
    failedReference.fileId,
    new Blob([remoteEncoded.text], { type: 'application/json' }),
  );

  const state = deviceState();
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  const failure = await expectIntegrityFailure(repository, state);
  for (let pass = 0; pass < 9; pass += 1) {
    drive.queueManifestListSnapshot([]);
  }
  await repository.repairFromValidRemoteGeneration(
    failure,
    fixture.snapshot,
    state,
    new AbortController().signal,
  );

  const confirmed = await repository.pull(state, new AbortController().signal);
  assert.equal(confirmed.requiresPublicationUpgrade, false);
  assert.equal(drive.manifestListSnapshots.length, 0);
  assert.ok(
    confirmed.snapshot.entities.some(
      (item) =>
        item.kind === 'note' &&
        (item.value as { content?: string }).content ===
          'Valid recovery generation hidden from list indexing',
    ),
  );
  assert.equal(logicalManifestHeads(await readManifestGenerations(drive)).length, 1);
});

test('explicit local-authoritative reset is root-bounded, clean, reloadable, and converges A to B to A', async () => {
  const drive = new InMemoryDrive();
  const fixture = await comprehensiveLegacyFixture();
  const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
  const root = drive.findByRole('root')[0];
  const legacyPdfId = legacy.manifest.documents[0].pdf?.fileId;
  assert.ok(legacyPdfId);

  const staleGenerationId = 'a'.repeat(64);
  const staleManifest = await drive.uploadFile(
    `39note-manifest-v1-${staleGenerationId}.json`,
    new Blob(['{"stale":true}'], { type: 'application/json' }),
    {
      parents: [root.id],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'manifest-generation',
        manifestStorage: IMMUTABLE_MANIFEST_STORAGE,
        generationId: staleGenerationId,
      },
    },
  );
  const orphanLibrary = await encodeCloudPayload(
    partitionSnapshot(fixture.snapshot).library,
  );
  const orphan = await drive.uploadFile(
    `library-${orphanLibrary.sha256.slice(0, 16)}.json`,
    new Blob([orphanLibrary.text], { type: 'application/json' }),
    {
      parents: [root.id],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'library',
        sha256: orphanLibrary.sha256,
      },
    },
  );
  const outsideFolder = await drive.createFolder('Outside 39Note', null, {});
  const outsideManagedLooking = await drive.uploadFile(
    'state.json',
    new Blob(['outside'], { type: 'application/json' }),
    {
      parents: [outsideFolder.id],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'state',
      },
    },
  );
  const unmanagedInsideRoot = await drive.uploadFile(
    'personal-note.txt',
    new Blob(['keep me'], { type: 'text/plain' }),
    { parents: [root.id] },
  );
  const managedDocumentFolder = drive.findByRole('document')[0];
  const unmanagedInsideDocumentFolder = await drive.uploadFile(
    'personal-document-note.txt',
    new Blob(['keep this too'], { type: 'text/plain' }),
    { parents: [managedDocumentFolder.id] },
  );

  const authoritative = structuredClone(fixture.snapshot);
  authoritative.pdfs = authoritative.pdfs.map((pdf) => ({
    ...pdf,
    fileId: legacyPdfId,
  }));
  const authoritativeBefore = structuredClone(authoritative);
  const stateA = deviceState();
  stateA.deviceId = 'profile-a';
  stateA.driveFiles.rootFolderId = root.id;
  const repositoryA = new GoogleDriveSyncRepository(drive.asClient());
  const mutationStart = drive.mutations.length;
  const reset = await repositoryA.resetFromLocal(
    authoritative,
    [fixture.pdf],
    stateA,
    new AbortController().signal,
  );

  assert.deepEqual(authoritative, authoritativeBefore);
  assert.ok(reset.filesTrashed >= legacy.legacyFileIds.length + 3);
  assert.equal(drive.files.get(root.id)?.trashed, undefined);
  assert.equal(drive.files.get(outsideFolder.id)?.trashed, undefined);
  assert.equal(drive.files.get(outsideManagedLooking.id)?.trashed, undefined);
  assert.equal(drive.files.get(unmanagedInsideRoot.id)?.trashed, undefined);
  assert.equal(drive.files.get(unmanagedInsideDocumentFolder.id)?.trashed, undefined);
  for (const fileId of [
    legacy.manifestFile.id,
    ...legacy.legacyFileIds,
    staleManifest.id,
    orphan.id,
  ]) {
    assert.equal(drive.files.get(fileId)?.trashed, true, fileId);
  }
  const resetTrashMutations = drive.mutations
    .slice(mutationStart)
    .filter((mutation) => mutation.operation === 'trash-for-reset');
  assert.equal(resetTrashMutations.length, reset.filesTrashed);
  for (const mutation of resetTrashMutations) {
    const file = drive.files.get(mutation.fileId);
    assert.ok(file);
    let parentId = file.parents?.[0];
    let insideSelectedRoot = false;
    while (parentId) {
      if (parentId === root.id) {
        insideSelectedRoot = true;
        break;
      }
      parentId = drive.files.get(parentId)?.parents?.[0];
    }
    assert.equal(insideSelectedRoot, true, mutation.fileId);
  }

  const activeGenerations = await readManifestGenerations(drive);
  const heads = logicalManifestHeads(activeGenerations);
  assert.equal(activeGenerations.length, 1);
  assert.equal(heads.length, 1);
  assert.equal(await verifyCloudManifestGeneration(heads[0]), true);
  assert.deepEqual(heads[0].generation.parents, []);
  assert.deepEqual(heads[0].generation.legacySources, []);
  assert.equal(heads[0].recoveryEvidence, undefined);
  assert.notEqual(heads[0].documents[0].pdf?.fileId, legacyPdfId);

  const stateB = deviceState();
  stateB.deviceId = 'profile-b';
  const repositoryB = new GoogleDriveSyncRepository(drive.asClient());
  const onB = await repositoryB.pull(stateB, new AbortController().signal);
  assert.equal(onB.requiresPublicationUpgrade, false);
  assert.deepEqual(orderedSnapshot(onB.snapshot), orderedSnapshot(reset.snapshot));

  const editFromB = structuredClone(onB.snapshot);
  const noteFromB = editFromB.entities.find((item) => item.kind === 'note');
  assert.ok(noteFromB);
  noteFromB.value = { ...(noteFromB.value as object), content: 'B to A after reset' };
  noteFromB.version = {
    updatedAt: noteFromB.version.updatedAt + 100,
    deviceId: 'profile-b',
    hash: await sha256Hex(stableStringify(noteFromB.value)),
  };
  editFromB.generatedAt += 100;
  editFromB.generatedBy = 'profile-b';
  await repositoryB.push(editFromB, [], stateB, new AbortController().signal);
  const backOnA = await new GoogleDriveSyncRepository(drive.asClient()).pull(
    deviceState(),
    new AbortController().signal,
  );
  assert.ok(
    backOnA.snapshot.entities.some(
      (item) =>
        item.kind === 'note' &&
        (item.value as { content?: string }).content === 'B to A after reset',
    ),
  );

  const editFromA = structuredClone(backOnA.snapshot);
  const noteFromA = editFromA.entities.find((item) => item.kind === 'note');
  assert.ok(noteFromA);
  noteFromA.value = { ...(noteFromA.value as object), content: 'A to B after reset' };
  noteFromA.version = {
    updatedAt: noteFromA.version.updatedAt + 100,
    deviceId: 'profile-a',
    hash: await sha256Hex(stableStringify(noteFromA.value)),
  };
  editFromA.generatedAt += 100;
  editFromA.generatedBy = 'profile-a';
  const stateAfterA = deviceState();
  const repositoryAfterA = new GoogleDriveSyncRepository(drive.asClient());
  await repositoryAfterA.pull(stateAfterA, new AbortController().signal);
  await repositoryAfterA.push(editFromA, [], stateAfterA, new AbortController().signal);
  const reloadedB = await new GoogleDriveSyncRepository(drive.asClient()).pull(
    deviceState(),
    new AbortController().signal,
  );
  assert.equal(reloadedB.requiresPublicationUpgrade, false);
  assert.ok(
    reloadedB.snapshot.entities.some(
      (item) =>
        item.kind === 'note' &&
        (item.value as { content?: string }).content === 'A to B after reset',
    ),
  );
  assert.equal(logicalManifestHeads(await readManifestGenerations(drive)).length, 1);
});

test('an interrupted explicit reset can be safely retried from the same local source', async () => {
  const drive = new InMemoryDrive();
  const fixture = await comprehensiveLegacyFixture();
  await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
  const root = drive.findByRole('root')[0];
  const state = deviceState();
  state.driveFiles.rootFolderId = root.id;
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  let trashAttempt = 0;
  drive.beforeTrash = () => {
    trashAttempt += 1;
    if (trashAttempt === 2) throw new Error('Simulated reset interruption.');
  };
  await assert.rejects(
    () =>
      repository.resetFromLocal(
        fixture.snapshot,
        [fixture.pdf],
        state,
        new AbortController().signal,
      ),
    /Simulated reset interruption/u,
  );
  assert.equal(
    drive.mutations.filter((mutation) => mutation.operation === 'trash-for-reset')
      .length,
    1,
  );
  drive.beforeTrash = undefined;
  const retried = await repository.resetFromLocal(
    fixture.snapshot,
    [fixture.pdf],
    state,
    new AbortController().signal,
  );
  assert.equal(retried.snapshot.entities.length, fixture.snapshot.entities.length);
  assert.equal(logicalManifestHeads(await readManifestGenerations(drive)).length, 1);
});

test('recovery revalidates failed bytes after candidate preservation and before publication', async () => {
  const drive = new InMemoryDrive();
  const fixture = await comprehensiveLegacyFixture();
  const legacy = await seedExactLegacyDrive(drive, fixture.snapshot, fixture.pdf);
  const reference = legacy.manifest.documents[0].state;
  const remoteSnapshot = structuredClone(fixture.snapshot);
  const note = remoteSnapshot.entities.find((item) => item.kind === 'note');
  assert.ok(note);
  note.value = { ...(note.value as object), content: 'First valid remote bytes' };
  note.version = {
    updatedAt: note.version.updatedAt + 1,
    deviceId: 'remote-b',
    hash: await sha256Hex(stableStringify(note.value)),
  };
  const payload = partitionSnapshot(remoteSnapshot).documents.get(
    note.documentId as string,
  )?.state;
  assert.ok(payload);
  const encoded = await encodeCloudPayload(payload);
  drive.setContent(
    reference.fileId,
    new Blob([encoded.text], { type: 'application/json' }),
  );
  const state = deviceState();
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  const failure = await expectIntegrityFailure(repository, state);
  let firstRecoveryUpload = true;
  drive.beforeUpload = ({ metadata }) => {
    if (metadata?.appProperties?.role !== 'state' || !firstRecoveryUpload) return;
    firstRecoveryUpload = false;
    drive.setContent(reference.fileId, new Blob(['second corrupt generation']));
  };
  const localBefore = structuredClone(fixture.snapshot);
  await assert.rejects(
    () =>
      repository.repairFromValidRemoteGeneration(
        failure,
        fixture.snapshot,
        state,
        new AbortController().signal,
      ),
    RemoteManifestChangedError,
  );
  assert.deepEqual(fixture.snapshot, localBefore);
  assert.equal(drive.manifestGenerations().length, 0);
  assert.equal(
    drive.mutations.some((mutation) => mutation.role === 'manifest-generation'),
    false,
  );
  assert.equal(
    await (drive.files.get(reference.fileId)?.content as Blob).text(),
    'second corrupt generation',
  );
});

test('manifest publication has no ETag, If-Match, or Drive-version CAS dependency', () => {
  const driveClient = source('../src/sync/driveClient.ts');
  const repository = source('../src/sync/driveRepository.ts');
  assert.doesNotMatch(repository, /httpEtag|If-Match|updateFileConditionally/u);
  assert.doesNotMatch(driveClient, /httpEtag|If-Match|updateFileConditionally/u);
  assert.equal(repository.match(/\.trashManagedFileForReset\(/gu)?.length, 1);
  assert.doesNotMatch(repository, /deleteFile|files\.delete/u);
  assert.match(repository, /role: 'manifest-generation'/u);
  assert.match(repository, /await this\.drive\.uploadFile\(/u);
  assert.doesNotMatch(
    repository,
    /version[^\n]{0,120}(?:PATCH|If-Match)|(?:PATCH|If-Match)[^\n]{0,120}version/u,
  );
});

test('ordinary immutable sync never performs destructive cleanup', async () => {
  const drive = new InMemoryDrive();
  const first = studySnapshot('Before ordinary update', 2, 'device-a');
  const seeded = await seedMemoryDrive(drive, first);
  const root = drive.findByRole('root')[0];
  const orphanPayload = await encodeCloudPayload(partitionSnapshot(first).library);
  const orphan = await drive.uploadFile(
    `library-${orphanPayload.sha256.slice(0, 16)}.json`,
    new Blob([orphanPayload.text], { type: 'application/json' }),
    {
      parents: [root.id],
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        role: 'library',
        sha256: orphanPayload.sha256,
      },
    },
  );
  const priorGenerations = drive.manifestGenerations().map((file) => file.id);
  const state = deviceState();
  const repository = new GoogleDriveSyncRepository(drive.asClient());
  await repository.pull(state, new AbortController().signal);
  const update = studySnapshot('After ordinary update', 3, 'device-a');
  const mutationStart = drive.mutations.length;
  await repository.push(update, [], state, new AbortController().signal);
  assert.equal(
    drive.mutations
      .slice(mutationStart)
      .some((mutation) => mutation.operation === 'trash-for-reset'),
    false,
  );
  assert.equal(drive.files.get(orphan.id)?.trashed, undefined);
  for (const fileId of priorGenerations) {
    assert.equal(drive.files.get(fileId)?.trashed, undefined);
  }
  assert.equal(seeded.state.driveFiles.rootFolderId, root.id);
});

test('an interrupted payload upload never publishes a valid-looking manifest', async () => {
  const drive = new InMemoryDrive();
  drive.beforeUpload = ({ name }) => {
    if (/^state-[a-f0-9]{16}\.json$/u.test(name)) {
      throw new Error('Simulated interrupted payload upload.');
    }
  };
  const state = deviceState();
  await assert.rejects(
    () =>
      new GoogleDriveSyncRepository(drive.asClient()).push(
        studySnapshot('Interrupted', 2, 'device-a'),
        [],
        state,
        new AbortController().signal,
      ),
    /Simulated interrupted payload upload/u,
  );
  assert.equal(
    drive.operations.some((operation) => operation.includes('39note-manifest.json')),
    false,
  );
  assert.equal(
    [...drive.files.values()].some((file) => file.name === '39note-manifest.json'),
    false,
  );
  assert.equal(state.remoteManifest, undefined);
});

test('multiple app-owned roots require explicit resolution and are never merged arbitrarily', async () => {
  const roots = ['root-1', 'root-2'].map((id) => ({
    id,
    name: '39Note',
    mimeType: 'application/vnd.google-apps.folder',
  }));
  const fakeDrive = {
    async listFiles() {
      return roots;
    },
  } as unknown as DriveClient;
  const repository = new GoogleDriveSyncRepository(fakeDrive);
  await assert.rejects(
    () => repository.pull(deviceState(), new AbortController().signal),
    (error: unknown) =>
      error instanceof MultipleDriveRootsError && error.roots.length === 2,
  );
});

test('cloud partitioning round-trips exact geometry, note numbers, drafts, and chat data', async () => {
  const geometry = [{ x: 0.123, y: 0.456, width: 0.222, height: 0.031 }];
  const records = [
    entity(
      'document',
      'doc-1',
      { documentId: 'doc-1', nextNoteNumber: 17 },
      1,
      'a',
      '1',
    ),
    entity(
      'annotation',
      'mark-1',
      { id: 'mark-1', type: 'highlight', rects: geometry, text: 'condition' },
      2,
      'a',
      '2',
      'doc-1',
    ),
    entity(
      'note',
      'note-1',
      {
        id: 'note-1',
        annotationId: 'mark-1',
        displayNumber: '16',
        content: 'editable',
      },
      3,
      'a',
      '3',
      'doc-1',
    ),
    entity(
      'print-draft',
      'doc-1',
      { documentId: 'doc-1', editorStateJson: '{"root":{}}' },
      4,
      'a',
      '4',
      'doc-1',
    ),
    entity(
      'ai-conversation',
      'chat-1',
      {
        id: 'chat-1',
        documentId: 'doc-1',
        messages: [{ role: 'user', content: 'why?' }],
      },
      5,
      'a',
      '5',
      'doc-1',
    ),
  ];
  const original = snapshot(records);
  const partitioned = partitionSnapshot(original);
  const stateEncoded = await encodeCloudPayload(
    partitioned.documents.get('doc-1')!.state,
  );
  const productivityEncoded = await encodeCloudPayload(
    partitioned.documents.get('doc-1')!.productivity,
  );
  const libraryEncoded = await encodeCloudPayload(partitioned.library);
  const aiEncoded = await encodeCloudPayload(partitioned.aiSettings);
  const manifest = {
    app: '39Note' as const,
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: 1,
    generatedBy: 'a',
    library: { fileId: 'library', sha256: libraryEncoded.sha256 },
    aiSettings: { fileId: 'ai', sha256: aiEncoded.sha256 },
    documents: [
      {
        documentId: 'doc-1',
        folderId: 'folder',
        state: { fileId: 'state', sha256: stateEncoded.sha256 },
        productivity: { fileId: 'productivity', sha256: productivityEncoded.sha256 },
      },
    ],
  };
  const combined = combineCloudPayloads(
    manifest,
    await parseCloudPayload(libraryEncoded.text, libraryEncoded.sha256),
    await parseCloudPayload(aiEncoded.text, aiEncoded.sha256),
    [
      await parseCloudPayload(stateEncoded.text, stateEncoded.sha256),
      await parseCloudPayload(productivityEncoded.text, productivityEncoded.sha256),
    ],
  );
  assert.deepEqual(combined.entities, records);
  assert.deepEqual((combined.entities[1].value as { rects: unknown }).rects, geometry);
  assert.equal(
    (combined.entities[0].value as { nextNoteNumber: number }).nextNoteNumber,
    17,
  );
  assert.equal(
    (combined.entities[2].value as { displayNumber: string }).displayNumber,
    '16',
  );
});

test('malformed, corrupt, and forward-version cloud data is rejected', async () => {
  await assert.rejects(() => parseCloudPayload('{bad', '0'.repeat(64)), /integrity/);
  const malformed = '{bad';
  const malformedHash = await sha256Hex(malformed);
  await assert.rejects(
    () => parseCloudPayload(malformed, malformedHash),
    /malformed JSON/,
  );
  const future = JSON.stringify({
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION + 1,
    generatedAt: 1,
    generatedBy: 'future',
    library: { fileId: 'a', sha256: 'a'.repeat(64) },
    aiSettings: { fileId: 'b', sha256: 'b'.repeat(64) },
    documents: [],
  });
  assert.throws(() => parseCloudManifest(future), /newer version/);
});

test('safe AI allowlist strips every credential-bearing field and URL secret', () => {
  const markers = [
    'fake-password',
    'fake-query-secret',
    'fake-fragment-secret',
    'fake-authorization-secret',
    'fake-api-key-secret',
    'fake-custom-secret',
  ];
  const safe = serializeSafeAiConfiguration({
    providerId: 'custom-openai-compatible',
    protocol: 'openai-chat-completions',
    providerLabel: 'Private endpoint',
    baseUrl:
      'https://user:fake-password@example.test/path?api_key=fake-query-secret#fake-fragment-secret',
    endpointPath: '/v1/chat?token=fake-query-secret',
    model: 'model',
    temperature: 0.2,
    maximumOutputTokens: 1_000,
    contextCharacterBudget: 10_000,
    customHeaders: {
      Authorization: 'fake-authorization-secret',
      'X-API-Key': 'fake-api-key-secret',
      'X-Custom': 'fake-custom-secret',
    },
    rememberApiKey: true,
    qwenRegion: 'custom',
    qwenWorkspaceId: '',
  });
  assert.equal(containsSecretMarker(safe, markers), false);
  assertNoSecretsInSyncPayload(safe);
  assert.doesNotMatch(
    JSON.stringify(safe),
    /customHeaders|rememberApiKey|authorization|api.key/iu,
  );
});

test('recursive secret guard rejects unsafe nested payload fields and credential URLs', () => {
  assert.throws(
    () =>
      assertNoSecretsInSyncPayload({ documents: [{ settings: { apiKey: 'fake' } }] }),
    /forbidden field/,
  );
  assert.throws(
    () => assertNoSecretsInSyncPayload({ endpoint: 'https://user:pass@example.test' }),
    /URL credentials/,
  );
});

test('device-session credentials are rejected from every Drive payload', () => {
  assert.throws(
    () =>
      assertNoSecretsInSyncPayload({
        nested: { googleDeviceSessionToken: 'test-device-session' },
      }),
    /forbidden field/u,
  );
  assert.throws(
    () => assertNoSecretsInSyncPayload({ session_token: 'test-device-session' }),
    /forbidden field/u,
  );
});

test('Library backup and selected-document packages cannot read the separate sync-auth database', () => {
  const backup = source('../src/services/libraryBackup.ts');
  const adapter = source('../src/sync/localAdapter.ts');
  assert.doesNotMatch(
    backup,
    /39note-sync|loadSyncDeviceState|googleDeviceSessionToken|sessionToken/,
  );
  assert.doesNotMatch(
    adapter,
    /googleDeviceSessionToken|sessionToken|exchangeVerifier/,
  );
});

test('persisted device session silently restores an in-memory access token after a simulated reload', async () => {
  const sessionToken = 's'.repeat(43);
  const authorizationHeaders: string[] = [];
  let call = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '');
    call += 1;
    return Response.json({
      accessToken: `memory-only-access-${call}`,
      expiresAt: Date.now() + 3_600_000,
    });
  }) as typeof fetch;
  try {
    const beforeReload = new PersistentGoogleAuthSession();
    beforeReload.configure('https://sync.example.test', 'device-reload', sessionToken);
    assert.equal(
      (await beforeReload.ensureAccessToken()).value,
      'memory-only-access-1',
    );

    const afterReload = new PersistentGoogleAuthSession();
    afterReload.configure('https://sync.example.test', 'device-reload', sessionToken);
    assert.equal((await afterReload.ensureAccessToken()).value, 'memory-only-access-2');
    assert.deepEqual(authorizationHeaders, [
      `Bearer ${sessionToken}`,
      `Bearer ${sessionToken}`,
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OAuth callback accepts the broker schema, retains the device session, and obtains an access token', async () => {
  const backendUrl = 'https://sync.example.test';
  const deviceId = 'device-oauth-success';
  const verifier = 'v'.repeat(43);
  const grant = 'g'.repeat(43);
  const sessionToken = 's'.repeat(43);
  const calls: Array<{ path: string; authorization: string | null }> = [];
  await withMockOAuthBrowser(
    {
      fragment: `#sync_auth_grant=${grant}`,
      pendingExchange: {
        backendUrl,
        deviceId,
        verifier,
        createdAt: Date.now(),
        sessionMode: 'personal',
      },
      fetcher: (async (input, init) => {
        const url = new URL(String(input));
        const authorization = new Headers(init?.headers).get('Authorization');
        calls.push({ path: url.pathname, authorization });
        if (url.pathname === '/api/oauth/exchange') {
          assert.deepEqual(JSON.parse(String(init?.body)), {
            grant,
            exchangeVerifier: verifier,
            deviceId,
          });
          return Response.json({
            sessionToken,
            session: {
              id: 'session-summary-id',
              deviceId,
              createdAt: 1_000,
              lastUsedAt: 1_000,
              current: true,
              sessionMode: 'personal',
              expiresAt: null,
            },
            sessionCount: 1,
            accountId: 'opaque-account-id',
            sessionMode: 'personal',
            expiresAt: null,
          });
        }
        assert.equal(url.pathname, '/api/google/access-token');
        return Response.json({
          accessToken: 'memory-only-test-access',
          expiresAt: Date.now() + 3_600_000,
        });
      }) as typeof fetch,
    },
    async ({ location, storage }) => {
      const identity = new PersistentGoogleAuthSession();
      identity.configure(backendUrl, deviceId);

      const exchange = await identity.completeAuthorizationIfPresent();
      assert.ok(exchange);
      assert.equal(identity.hasDeviceSession, true);
      assert.equal(identity.persistedSessionToken, sessionToken);
      assert.equal(storage.getItem(PENDING_EXCHANGE_STORAGE_KEY), null);
      assert.equal(location.hash, '');

      assert.equal(
        (await identity.ensureAccessToken()).value,
        'memory-only-test-access',
      );
      assert.deepEqual(calls, [
        { path: '/api/oauth/exchange', authorization: null },
        { path: '/api/google/access-token', authorization: `Bearer ${sessionToken}` },
      ]);
    },
  );
});

test('malformed and stale pending OAuth exchanges are removed without transmitting a grant', async () => {
  const backendUrl = 'https://sync.example.test';
  const deviceId = 'device-oauth-expired';
  const scenarios: Array<string | Record<string, unknown>> = [
    '{malformed-json',
    {
      backendUrl,
      deviceId,
      verifier: 'v'.repeat(43),
      createdAt: Date.now() - 16 * 60_000,
    },
  ];
  for (const pendingExchange of scenarios) {
    let fetchCalls = 0;
    await withMockOAuthBrowser(
      {
        fragment: `#sync_auth_grant=${'g'.repeat(43)}`,
        pendingExchange,
        fetcher: (async () => {
          fetchCalls += 1;
          throw new Error('Unexpected OAuth exchange request.');
        }) as typeof fetch,
      },
      async ({ location, storage }) => {
        const identity = new PersistentGoogleAuthSession();
        identity.configure(backendUrl, deviceId);
        await assert.rejects(
          () => identity.completeAuthorizationIfPresent(),
          (error: unknown) =>
            error instanceof GoogleReauthorizationRequiredError &&
            /exchange expired/u.test(error.message),
        );
        assert.equal(fetchCalls, 0);
        assert.equal(storage.getItem(PENDING_EXCHANGE_STORAGE_KEY), null);
        assert.equal(location.hash, '');
        assert.equal(identity.hasDeviceSession, false);
      },
    );
  }
});

test('malformed successful OAuth exchange response is rejected without retaining a device session', async () => {
  const backendUrl = 'https://sync.example.test';
  const deviceId = 'device-oauth-malformed';
  await withMockOAuthBrowser(
    {
      fragment: `#sync_auth_grant=${'g'.repeat(43)}`,
      pendingExchange: {
        backendUrl,
        deviceId,
        verifier: 'v'.repeat(43),
        createdAt: Date.now(),
        sessionMode: 'personal',
      },
      fetcher: (async () =>
        Response.json({
          session_token: 's'.repeat(43),
          session: {
            id: 'session-summary-id',
            deviceId,
            createdAt: 1_000,
            lastUsedAt: 1_000,
            current: true,
          },
          sessionCount: 1,
        })) as typeof fetch,
    },
    async ({ location, storage }) => {
      const identity = new PersistentGoogleAuthSession();
      identity.configure(backendUrl, deviceId);
      await assert.rejects(
        () => identity.completeAuthorizationIfPresent(),
        SyncBackendUnavailableError,
      );
      assert.equal(identity.hasDeviceSession, false);
      assert.equal(identity.persistedSessionToken, null);
      assert.equal(storage.getItem(PENDING_EXCHANGE_STORAGE_KEY), null);
      assert.equal(location.hash, '');
    },
  );
});

test('OAuth callback errors map to sanitized user-facing failures without calling the exchange endpoint', async () => {
  const scenarios = [
    {
      parameters: { sync_auth_error: 'authorization_cancelled' },
      errorType: Error,
      message: 'Google Drive authorization was cancelled.',
    },
    {
      parameters: { sync_auth_error: 'google_temporarily_unavailable' },
      errorType: SyncBackendUnavailableError,
      message:
        'Persistent sync service is temporarily unavailable. Local work remains available and queued.',
    },
    {
      parameters: {
        sync_auth_error: 'refresh_token_missing',
        sync_auth_action: 'reconsent',
      },
      errorType: GoogleReauthorizationRequiredError,
      message:
        'Google did not return persistent permission. Choose Reauthorize Google Drive and approve access again.',
    },
    {
      parameters: {
        sync_auth_error: 'authorization_rejected',
        sync_auth_action: 'reconsent',
      },
      errorType: GoogleReauthorizationRequiredError,
      message:
        'Google rejected the authorization exchange. Verify the OAuth client configuration, then choose Reauthorize Google Drive.',
    },
    {
      parameters: { sync_auth_error: 'authorization_response_invalid' },
      errorType: Error,
      message:
        'Google returned an incomplete authorization response. Connect Google Drive again.',
    },
    {
      parameters: { sync_auth_error: 'google_invalid_response' },
      errorType: Error,
      message:
        'Google returned an unexpected response during authorization. Verify that the Google Drive API is enabled, then connect again.',
    },
    {
      parameters: {
        sync_auth_error: 'private_provider_detail',
        private_detail: 'must-not-be-displayed',
      },
      errorType: Error,
      message: 'Google Drive authorization could not be completed.',
    },
  ];
  for (const scenario of scenarios) {
    let fetchCalls = 0;
    await withMockOAuthBrowser(
      {
        fragment: `#${new URLSearchParams(scenario.parameters).toString()}`,
        pendingExchange: {
          backendUrl: 'https://sync.example.test',
          deviceId: 'device-oauth-error',
          verifier: 'v'.repeat(43),
          createdAt: Date.now(),
        },
        fetcher: (async () => {
          fetchCalls += 1;
          throw new Error('Unexpected OAuth exchange request.');
        }) as typeof fetch,
      },
      async ({ location, storage }) => {
        const identity = new PersistentGoogleAuthSession();
        identity.configure('https://sync.example.test', 'device-oauth-error');
        await assert.rejects(
          () => identity.completeAuthorizationIfPresent(),
          (error: unknown) =>
            error instanceof scenario.errorType &&
            error.message === scenario.message &&
            !error.message.includes('private') &&
            !error.message.includes('must-not-be-displayed'),
        );
        assert.equal(fetchCalls, 0);
        assert.equal(storage.getItem(PENDING_EXCHANGE_STORAGE_KEY), null);
        assert.equal(location.hash, '');
      },
    );
  }
});

test('sync broker URL accepts HTTPS and local HTTP but rejects credentialed or remote HTTP URLs', () => {
  assert.equal(
    validateSyncAuthUrl('https://sync.example.test/'),
    'https://sync.example.test',
  );
  assert.equal(validateSyncAuthUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.throws(
    () => validateSyncAuthUrl('http://sync.example.test'),
    /must be HTTPS/u,
  );
  assert.throws(
    () => validateSyncAuthUrl('https://user:pass@sync.example.test'),
    /must be HTTPS/u,
  );
});

test('15 MB original PDF uses one resumable session and two chunks', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const telemetry: DriveRequestTelemetryEvent[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(null, {
        status: 200,
        headers: {
          Location:
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1',
        },
      });
    }
    if (calls.length === 2) return new Response(null, { status: 308 });
    return Response.json({
      id: 'pdf-file-1',
      name: 'original.pdf',
      mimeType: 'application/pdf',
    });
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => 'fake-google-oauth-token', {
      onTelemetry: (event) => telemetry.push({ ...event }),
    });
    const operationId = client.beginOperationTelemetry('upload');
    const progress: number[] = [];
    const blob = new Blob([new Uint8Array(15 * 1024 * 1024)], {
      type: 'application/pdf',
    });
    const file = await client.uploadFile(
      'original.pdf',
      blob,
      { parents: ['folder'] },
      new AbortController().signal,
      (uploaded) => progress.push(uploaded),
    );
    assert.equal(file.id, 'pdf-file-1');
    assert.equal(
      calls.filter(
        (call) =>
          call.url.includes('uploadType=resumable') && call.init?.method === 'POST',
      ).length,
      1,
    );
    const resumableInitializationUrl = new URL(calls[0].url);
    assert.match(
      resumableInitializationUrl.searchParams.get('fields') ?? '',
      /trashed/u,
    );
    assert.match(
      resumableInitializationUrl.searchParams.get('fields') ?? '',
      /ownedByMe/u,
    );
    assert.equal(calls.filter((call) => call.init?.method === 'PUT').length, 2);
    assert.deepEqual(progress, [8 * 1024 * 1024, 15 * 1024 * 1024]);
    const snapshot = client.finishOperationTelemetry(operationId);
    assert.ok(snapshot);
    assert.equal(
      summarizeDriveOperationTelemetry(snapshot).bytesTransferred,
      blob.size,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('untrusted resumable Location is rejected before any authenticated chunk upload', async () => {
  const scenarios = [
    {
      name: 'cross-origin',
      location:
        'https://upload.example.test/upload/drive/v3/files?uploadType=resumable&upload_id=stolen-session',
      message: /untrusted resumable upload session/u,
    },
    {
      name: 'malformed',
      location: 'not a valid URL',
      message: /invalid resumable upload session/u,
    },
  ] as const;
  const previousFetch = globalThis.fetch;
  try {
    for (const scenario of scenarios) {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(null, {
          status: 200,
          headers: { Location: scenario.location },
        });
      }) as typeof fetch;

      const client = new DriveClient(() => 'fake-google-oauth-token');
      await assert.rejects(
        () =>
          client.uploadFile(
            `${scenario.name}.pdf`,
            new Blob([new Uint8Array(15 * 1024 * 1024)], {
              type: 'application/pdf',
            }),
            { parents: ['folder'] },
            new AbortController().signal,
          ),
        (error: unknown) =>
          error instanceof DriveRequestError &&
          error.status === 502 &&
          scenario.message.test(error.message),
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init?.method, 'POST');
      const initializationUrl = new URL(calls[0].url);
      assert.equal(initializationUrl.origin, 'https://www.googleapis.com');
      assert.equal(initializationUrl.pathname, '/upload/drive/v3/files');
      assert.equal(initializationUrl.searchParams.get('uploadType'), 'resumable');
      assert.equal(initializationUrl.searchParams.get('upload_id'), null);
      assert.equal(
        calls.some((call) => (call.init?.method ?? 'GET').toUpperCase() === 'PUT'),
        false,
        `${scenario.name} Location must be rejected before a chunk PUT`,
      );
      assert.equal(
        calls.some((call) => call.url === scenario.location),
        false,
        `${scenario.name} Location must never receive the bearer-authenticated request`,
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Drive write transport keeps uploads create-only and uses scoped Trash PATCHes', async () => {
  const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body,
    });
    return Response.json({
      id: `drive-file-${calls.length}`,
      name: 'test',
      mimeType: 'application/json',
      trashed: false,
    });
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => 'fake-google-oauth-token');
    const signal = new AbortController().signal;
    await client.createFolder('39Note', null, { role: 'root' }, signal);
    await client.updateMetadata(
      'folder-1',
      { appProperties: { role: 'root' } },
      signal,
    );
    await client.uploadFile(
      `39note-manifest-v1-${'a'.repeat(64)}.json`,
      new Blob(['{}'], { type: 'application/json' }),
      {
        parents: ['folder-1'],
        appProperties: { role: 'manifest-generation' },
      },
      signal,
    );
    await client.trashManagedFileForReset('managed-file-1', signal);
    await client.trashManagedLegacyFile('legacy-file-1', signal);
    await client.restoreManagedPaperFolder(
      'paper-folder-1',
      'root-folder',
      ['old-parent'],
      signal,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(
    calls.map((call) => call.method),
    ['POST', 'PATCH', 'POST', 'PATCH', 'PATCH', 'PATCH'],
  );
  assert.deepEqual(JSON.parse(String(calls.at(-2)?.body)), { trashed: true });
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.body)), { trashed: false });
  assert.match(calls.at(-3)?.url ?? '', /\/files\/managed-file-1\?/u);
  assert.match(calls.at(-2)?.url ?? '', /\/files\/legacy-file-1\?/u);
  const restoreUrl = new URL(calls.at(-1)?.url ?? 'https://invalid.test');
  assert.equal(restoreUrl.pathname, '/drive/v3/files/paper-folder-1');
  assert.equal(restoreUrl.searchParams.get('addParents'), 'root-folder');
  assert.equal(restoreUrl.searchParams.get('removeParents'), 'old-parent');
  assert.match(restoreUrl.searchParams.get('fields') ?? '', /parents/u);
  assert.match(restoreUrl.searchParams.get('fields') ?? '', /trashed/u);
  assert.match(restoreUrl.searchParams.get('fields') ?? '', /ownedByMe/u);
  assert.equal(
    calls.some((call) => call.method === 'DELETE'),
    false,
  );
  assert.equal(
    calls.filter((call) => call.url.includes('upload/drive/v3/files')).length,
    1,
  );
  const uploadUrl = new URL(calls[2].url);
  assert.match(uploadUrl.searchParams.get('fields') ?? '', /sha256Checksum/u);
  assert.match(uploadUrl.searchParams.get('fields') ?? '', /trashed/u);
  assert.match(uploadUrl.searchParams.get('fields') ?? '', /ownedByMe/u);
  assert.ok(
    calls.every((call) =>
      /^https:\/\/www\.googleapis\.com\/(?:upload\/)?drive\/v3\//u.test(call.url),
    ),
  );
});

test('the Drive primitives used by Retry verification issue GET-only requests', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    if (url.includes('/files?')) return Response.json({ files: [] });
    if (url.includes('alt=media')) {
      return new Response('{"app":"39Note"}', {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.json({
      id: 'drive-file-1',
      name: 'state.json',
      mimeType: 'application/json',
      version: '9',
    });
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => 'fake-google-oauth-token');
    const signal = new AbortController().signal;
    await client.listFiles("name='state.json'", signal);
    await client.getMetadata('state-1', signal);
    await client.downloadText('state-1', signal);
    await client.downloadBlob('state-1', signal);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(
    calls.every((call) => call.url.startsWith('https://www.googleapis.com/drive/v3/')),
  );
});

test('Drive change discovery exhausts every page and emits only redacted request telemetry', async () => {
  const calls: URL[] = [];
  const telemetry: DriveRequestTelemetryEvent[] = [];
  const previousFetch = globalThis.fetch;
  let clock = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith('/changes/startPageToken')) {
      return Response.json({ startPageToken: 'baseline-secret-token' });
    }
    const token = url.searchParams.get('pageToken');
    if (token === 'baseline-secret-token') {
      return Response.json({
        changes: [
          {
            fileId: 'manifest-a',
            removed: false,
            file: {
              id: 'manifest-a',
              name: 'manifest-a.json',
              mimeType: 'application/json',
              parents: ['data-a'],
              appProperties: {
                application: '39Note',
                role: 'paper-manifest-generation',
                documentId: 'doc-a',
              },
            },
          },
        ],
        nextPageToken: 'second-secret-token',
      });
    }
    assert.equal(token, 'second-secret-token');
    return Response.json({
      changes: [
        {
          fileId: 'payload-a',
          removed: true,
        },
      ],
      newStartPageToken: 'committable-secret-token',
    });
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => 'bearer-secret-token', {
      onTelemetry: (event) => telemetry.push({ ...event }),
      now: () => (clock += 5),
    });
    const signal = new AbortController().signal;
    assert.equal(await client.getStartPageToken(signal), 'baseline-secret-token');
    const batch = await client.listChanges('baseline-secret-token', signal);
    assert.equal(batch.pages, 2);
    assert.equal(batch.newStartPageToken, 'committable-secret-token');
    assert.deepEqual(
      batch.changes.map(({ fileId, removed }) => ({ fileId, removed })),
      [
        { fileId: 'manifest-a', removed: false },
        { fileId: 'payload-a', removed: true },
      ],
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(
    calls.map((url) => url.searchParams.get('pageToken')),
    [null, 'baseline-secret-token', 'second-secret-token'],
  );
  assert.ok(calls.every((url) => url.searchParams.get('pageSize') !== '0'));
  assert.deepEqual(
    telemetry.map(({ operation, attempt, outcome, status }) => ({
      operation,
      attempt,
      outcome,
      status,
    })),
    [
      { operation: 'changes', attempt: 1, outcome: 'success', status: 200 },
      { operation: 'changes', attempt: 1, outcome: 'success', status: 200 },
      { operation: 'changes', attempt: 1, outcome: 'success', status: 200 },
    ],
  );
  const serializedTelemetry = JSON.stringify(telemetry);
  for (const secret of [
    'baseline-secret-token',
    'second-secret-token',
    'committable-secret-token',
    'bearer-secret-token',
    'https://www.googleapis.com',
  ]) {
    assert.equal(serializedTelemetry.includes(secret), false);
  }
});

test('Drive operation telemetry records redacted phases, parallel waves, bytes, and scoped retries', async () => {
  const telemetry: DriveRequestTelemetryEvent[] = [];
  const previousFetch = globalThis.fetch;
  let clock = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get('alt') === 'media') {
      return new Response('sensitive-document-contents', {
        headers: { 'Content-Length': '27', 'Content-Type': 'application/pdf' },
      });
    }
    if (url.pathname.endsWith('/files')) {
      return Response.json({ files: [] });
    }
    return Response.json({
      id: 'root-id',
      name: '39Note',
      mimeType: 'application/vnd.google-apps.folder',
      ownedByMe: true,
    });
  }) as typeof fetch;

  try {
    const client = new DriveClient(() => 'bearer-secret-token', {
      onTelemetry: (event) => telemetry.push({ ...event }),
      now: () => (clock += 5),
    });
    const signal = new AbortController().signal;
    const operationId = client.beginOperationTelemetry('download');
    client.recordOperationStateTransition({
      phase: 'operation-owner',
      transition: 'operation-owner-acquired',
      documentId: 'document-a',
      outcome: 'succeeded',
    });
    await Promise.all([
      client.getMetadata('root-id', signal, {
        phase: 'root-validation',
        dependencyPhase: 'prepare',
        documentId: 'document-a',
      }),
      client.downloadBlob('source-pdf-id', signal, {
        phase: 'network-download',
        dependencyPhase: 'package-transfer',
        documentId: 'document-a',
      }),
    ]);
    await client.measureOperationPhase(
      'sha-verification',
      async () => Promise.resolve(),
      { documentId: 'document-a', bytesProcessed: 27 },
    );
    client.recordOperationStateTransition({
      phase: 'local-application',
      transition: 'paper-state-updated',
      documentId: 'document-a',
      previousPaperState: 'cloud-only',
      nextPaperState: 'synced',
      outcome: 'succeeded',
    });
    client.recordOperationRetry();
    await client.listFiles("name='secret-query-fragment'", signal, {
      phase: 'presence-resolution',
      dependencyPhase: 'commit-guard',
      documentId: 'document-a',
    });
    const snapshot = client.finishOperationTelemetry(operationId);
    assert.ok(snapshot);

    const summary = summarizeDriveOperationTelemetry(snapshot);
    assert.equal(summary.operationId, operationId);
    assert.equal(summary.operationType, 'download');
    assert.equal(summary.requestCount, 3);
    assert.equal(summary.maximumSequentialDependencyDepth, 2);
    assert.equal(summary.parallelWaves, 2);
    assert.equal(summary.bytesTransferred, 27);
    assert.equal(summary.retryCount, 1);
    assert.deepEqual(
      summary.phases.map(({ phase }) => phase),
      [
        'network-download',
        'presence-resolution',
        'root-validation',
        'sha-verification',
      ],
    );
    assert.equal(snapshot.operationRetryCount, 1);
    assert.deepEqual(
      snapshot.stateTransitions.map(
        ({ paperCorrelationId, transition, previousPaperState, nextPaperState }) => ({
          paperCorrelationId,
          transition,
          previousPaperState,
          nextPaperState,
        }),
      ),
      [
        {
          paperCorrelationId: 'paper-1',
          transition: 'operation-owner-acquired',
          previousPaperState: undefined,
          nextPaperState: undefined,
        },
        {
          paperCorrelationId: 'paper-1',
          transition: 'paper-state-updated',
          previousPaperState: 'cloud-only',
          nextPaperState: 'synced',
        },
      ],
    );
    assert.deepEqual(
      snapshot.phaseSpans.map(({ paperCorrelationId, bytesProcessed }) => ({
        paperCorrelationId,
        bytesProcessed,
      })),
      [{ paperCorrelationId: 'paper-1', bytesProcessed: 27 }],
    );
    assert.ok(
      telemetry.every(
        (event) =>
          event.operationId === operationId &&
          event.operationType === 'download' &&
          event.startedAtMs <= event.endedAtMs &&
          event.relativeStartMs !== undefined &&
          event.relativeEndMs !== undefined &&
          event.requestCategory === event.operation &&
          Boolean(event.phase) &&
          Boolean(event.dependencyPhase) &&
          event.paperCorrelationId === 'paper-1' &&
          Boolean(event.fileCorrelationId) ===
            (event.resource === 'file-metadata' || event.resource === 'file-content'),
      ),
    );

    const diagnostic = formatDriveOperationDiagnostic(summary);
    assert.match(diagnostic, /^Download paper:/u);
    assert.match(diagnostic, /network-download/u);
    assert.match(diagnostic, /requests 3 · waves 2 · retries 1 · bytes 27/u);

    const scanOperationId = client.beginOperationTelemetry('scan');
    client.recordOperationStateTransition({
      phase: 'incremental-discovery',
      transition: 'changes-invalidation-classified',
      documentId: 'document-a',
      classification: 'same-paper-change',
      outcome: 'succeeded',
    });
    const followUpSnapshot = client.finishOperationTelemetry(scanOperationId);
    assert.equal(
      followUpSnapshot?.stateTransitions[0]?.paperCorrelationId,
      snapshot.stateTransitions[0]?.paperCorrelationId,
    );

    const serializedDiagnostics = JSON.stringify({
      telemetry,
      snapshot,
      followUpSnapshot,
      diagnostic,
    });
    for (const secret of [
      'bearer-secret-token',
      'secret-query-fragment',
      'sensitive-document-contents',
      'document-a',
      'source-pdf-id',
      'root-id',
      'https://www.googleapis.com',
      'alt=media',
    ]) {
      assert.equal(serializedDiagnostics.includes(secret), false);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Drive telemetry allowlists fields and redacts hostile diagnostic labels', async () => {
  const previousFetch = globalThis.fetch;
  const telemetry: DriveRequestTelemetryEvent[] = [];
  const secret = 'Bearer raw-access-token?client_secret=never-log';
  globalThis.fetch = (async () =>
    Response.json({
      id: 'private-file-id',
      name: '39Note',
      mimeType: 'application/vnd.google-apps.folder',
      ownedByMe: true,
    })) as typeof fetch;

  try {
    const client = new DriveClient(() => 'private-access-token', {
      onTelemetry: (event) => telemetry.push({ ...event }),
    });
    const operationId = client.beginOperationTelemetry('scan');
    const hostileContext = {
      phase: secret,
      dependencyPhase: `https://drive.invalid/?token=${secret}`,
      resource: 'file-metadata',
      documentId: 'private-document-id',
      fileId: 'private-file-id',
      authorization: secret,
      query: secret,
      body: secret,
    } as DriveRequestContext & Record<string, unknown>;
    await client.getMetadata(
      'private-file-id',
      new AbortController().signal,
      hostileContext,
    );
    await client.measureOperationPhase(secret, async () => undefined, {
      documentId: 'private-document-id',
    });
    client.recordOperationStateTransition({
      phase: secret,
      transition: 'operation-issue-observed',
      documentId: 'private-document-id',
      issueCode: secret,
      classification: secret,
      outcome: 'failed',
      authorization: secret,
    } as Parameters<DriveClient['recordOperationStateTransition']>[0] &
      Record<string, unknown>);
    const snapshot = client.finishOperationTelemetry(operationId);
    assert.ok(snapshot);

    assert.equal(telemetry[0]?.phase, undefined);
    assert.equal(telemetry[0]?.dependencyPhase, 'uncategorized');
    assert.equal(snapshot.phaseSpans[0]?.phase, 'redacted');
    assert.equal(snapshot.stateTransitions[0]?.phase, 'redacted');
    assert.equal(snapshot.stateTransitions[0]?.issueCode, 'redacted');
    assert.equal(snapshot.stateTransitions[0]?.classification, 'redacted');
    const serialized = JSON.stringify({ telemetry, snapshot });
    for (const forbidden of [
      secret,
      'private-access-token',
      'private-document-id',
      'private-file-id',
      'authorization',
      'query',
      'body',
      'https://drive.invalid',
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('retained operation diagnostics bound large transition traces while preserving both edges', () => {
  const client = new DriveClient(() => 'not-transmitted');
  const operationId = client.beginOperationTelemetry('scan');
  for (let index = 0; index < 300; index += 1) {
    client.recordOperationStateTransition({
      phase: 'discovery-settlement',
      transition: 'discovery-state-applied',
      classification: `step-${index}`,
      outcome: 'succeeded',
    });
  }
  const snapshot = client.finishOperationTelemetry(operationId);
  assert.ok(snapshot);
  const summary = summarizeDriveOperationTelemetry(snapshot);
  assert.equal(summary.stateTransitions.length, 256);
  assert.equal(summary.stateTransitions[0]?.classification, 'step-0');
  assert.equal(summary.stateTransitions[127]?.classification, 'step-127');
  assert.equal(summary.stateTransitions[128]?.classification, 'step-172');
  assert.equal(summary.stateTransitions.at(-1)?.classification, 'step-299');
});

test('Drive telemetry preserves causal waves while an unrelated sibling remains in flight', async () => {
  const previousFetch = globalThis.fetch;
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = ((input: string | URL | Request) => {
    const id = new URL(String(input)).pathname.split('/').at(-1)!;
    return new Promise<Response>((resolve) => pending.set(id, resolve));
  }) as typeof fetch;
  const waitForRequest = async (id: string) => {
    for (let attempt = 0; attempt < 20 && !pending.has(id); attempt += 1) {
      await Promise.resolve();
    }
    assert.ok(pending.has(id), `Expected pending Drive request ${id}`);
  };
  const resolveMetadata = (id: string) => {
    pending.get(id)?.(
      Response.json({
        id,
        name: id,
        mimeType: 'application/json',
        ownedByMe: true,
      }),
    );
    pending.delete(id);
  };

  try {
    const client = new DriveClient(() => 'redacted-token');
    const signal = new AbortController().signal;
    const operationId = client.beginOperationTelemetry('download');
    const first = client.getMetadata('first', signal, { phase: 'first' });
    const slowSibling = client.getMetadata('slow-sibling', signal, {
      phase: 'slow-sibling',
    });
    await Promise.all([waitForRequest('first'), waitForRequest('slow-sibling')]);
    resolveMetadata('first');
    await first;

    const second = client.getMetadata('second', signal, { phase: 'second' });
    await waitForRequest('second');
    resolveMetadata('second');
    await second;

    const third = client.getMetadata('third', signal, { phase: 'third' });
    await waitForRequest('third');
    resolveMetadata('third');
    await third;
    resolveMetadata('slow-sibling');
    await slowSibling;

    const snapshot = client.finishOperationTelemetry(operationId);
    assert.ok(snapshot);
    assert.deepEqual(
      Object.fromEntries(
        snapshot.events.map((event) => [event.phase, event.parallelWave]),
      ),
      { first: 1, second: 2, third: 3, 'slow-sibling': 1 },
    );
    assert.equal(
      summarizeDriveOperationTelemetry(snapshot).maximumSequentialDependencyDepth,
      3,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Drive change discovery rejects invalid cursors and malformed or looping pagination', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      Response.json({ changes: [], nextPageToken: 'loop-token' })) as typeof fetch;
    const looping = new DriveClient(() => 'token');
    await assert.rejects(
      () => looping.listChanges('loop-token', new AbortController().signal),
      (error: unknown) =>
        error instanceof DriveRequestError && error.code === 'invalid-response',
    );

    globalThis.fetch = (async () =>
      Response.json({
        changes: [{ fileId: 'missing-file-metadata' }],
      })) as typeof fetch;
    const malformed = new DriveClient(() => 'token');
    await assert.rejects(
      () => malformed.listChanges('cursor', new AbortController().signal),
      (error: unknown) =>
        error instanceof DriveRequestError && error.code === 'invalid-response',
    );

    globalThis.fetch = (async () =>
      Response.json(
        { error: { message: 'raw stale cursor detail' } },
        { status: 410 },
      )) as typeof fetch;
    const expired = new DriveClient(() => 'token');
    await assert.rejects(
      () => expired.listChanges('expired-cursor', new AbortController().signal),
      (error: unknown) =>
        error instanceof DriveRequestError &&
        error.code === 'change-token-invalid' &&
        !error.message.includes('raw stale cursor detail'),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('change-feed records are conservative invalidations, never authoritative heads', () => {
  const cachedPaper = {
    documentId: 'doc-a',
    displayName: 'A',
    deleted: false,
    paperFolderId: 'folder-a',
    dataFolderId: 'data-a',
    headIds: ['head-a'],
    headSetId: 'head-a',
    localAvailability: 'local-and-cloud' as const,
    status: 'synced' as const,
    managedFileIds: ['known-payload-a'],
  };
  const manifestChange = {
    fileId: 'manifest-a',
    removed: false,
    file: {
      id: 'manifest-a',
      name: 'manifest.json',
      mimeType: 'application/json',
      appProperties: {
        application: '39Note',
        role: 'paper-manifest-generation',
        documentId: 'doc-a',
      },
    },
  };
  const scoped = planPaperChangeDiscovery(
    [manifestChange, manifestChange, { fileId: 'known-payload-a', removed: true }],
    'root',
    [cachedPaper],
  );
  assert.deepEqual(scoped, {
    affectedDocumentIds: ['doc-a'],
    removedManagedFiles: [{ documentId: 'doc-a', fileId: 'known-payload-a' }],
    requiresFullAudit: false,
    reasons: [],
  });

  const foreign = planPaperChangeDiscovery(
    [
      {
        fileId: 'foreign-file',
        removed: false,
        file: {
          id: 'foreign-file',
          name: 'foreign.txt',
          mimeType: 'text/plain',
        },
      },
    ],
    'root',
    [cachedPaper],
  );
  assert.deepEqual(foreign, {
    affectedDocumentIds: [],
    removedManagedFiles: [],
    requiresFullAudit: false,
    reasons: [],
  });

  const suspicious = planPaperChangeDiscovery(
    [
      { fileId: 'unknown-removed', removed: true },
      {
        fileId: 'root',
        removed: false,
        file: {
          id: 'root',
          name: '39Note',
          mimeType: 'application/vnd.google-apps.folder',
          appProperties: { application: '39Note', role: 'root' },
        },
      },
    ],
    'root',
    [cachedPaper],
  );
  assert.equal(suspicious.requiresFullAudit, true);
  assert.deepEqual(suspicious.reasons, ['root-changed', 'unknown-removal']);
});

test('Paper-v3 presence changes invalidate only their exact document', () => {
  const cachedPaper = {
    documentId: 'doc-a',
    displayName: 'A',
    deleted: false,
    paperFolderId: 'folder-a',
    dataFolderId: 'data-a',
    headIds: ['head-a'],
    headSetId: 'head-a',
    presenceState: 'present' as const,
    presenceHeadIds: ['presence-old'],
    localAvailability: 'local-and-cloud' as const,
    status: 'synced' as const,
    managedFileIds: ['presence-old'],
  };
  const added = planPaperChangeDiscovery(
    [
      {
        fileId: 'presence-new',
        removed: false,
        file: {
          id: 'presence-new',
          name: 'display-name-is-not-authority.json',
          mimeType: 'application/json',
          appProperties: {
            application: '39Note',
            role: 'paper-presence-generation',
            documentId: 'doc-a',
          },
        },
      },
    ],
    'root',
    [cachedPaper],
  );
  assert.deepEqual(added, {
    affectedDocumentIds: ['doc-a'],
    removedManagedFiles: [],
    requiresFullAudit: false,
    reasons: [],
  });

  const removedKnown = planPaperChangeDiscovery(
    [{ fileId: 'presence-old', removed: true }],
    'root',
    [cachedPaper],
  );
  assert.deepEqual(removedKnown, {
    affectedDocumentIds: ['doc-a'],
    removedManagedFiles: [{ documentId: 'doc-a', fileId: 'presence-old' }],
    requiresFullAudit: false,
    reasons: [],
  });

  const removedUnknown = planPaperChangeDiscovery(
    [{ fileId: 'unknown-presence', removed: true }],
    'root',
    [cachedPaper],
  );
  assert.equal(removedUnknown.requiresFullAudit, true);
  assert.deepEqual(removedUnknown.reasons, ['unknown-removal']);
});

test('Paper-v3 control changes conservatively require a full audit', () => {
  for (const role of [
    'paper-v3-control',
    'paper-v3-layout-descriptor',
    'paper-v3-migration-completion',
  ]) {
    const plan = planPaperChangeDiscovery(
      [
        {
          fileId: `changed-${role}`,
          removed: false,
          file: {
            id: `changed-${role}`,
            name: 'presentation-only-name',
            mimeType: 'application/json',
            appProperties: { application: '39Note', role },
          },
        },
      ],
      'root',
      [],
    );
    assert.equal(plan.requiresFullAudit, true, role);
    assert.deepEqual(plan.affectedDocumentIds, [], role);
    assert.deepEqual(plan.reasons, ['managed-structure-changed'], role);
  }
});

test('ambiguous network failure does not automatically retry a create request', async () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new TypeError('network disconnected');
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => 'fake-google-oauth-token');
    await assert.rejects(
      () =>
        client.uploadFile(
          'small.json',
          new Blob(['{}'], { type: 'application/json' }),
          { parents: ['folder'] },
          new AbortController().signal,
        ),
      (error: unknown) =>
        error instanceof DriveNetworkError && error.operation === 'upload',
    );
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('ambiguous 500 response does not retry a create request that could duplicate a file', async () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json(
      { error: { message: 'ambiguous create failure' } },
      { status: 500 },
    );
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => 'fake-google-oauth-token');
    await assert.rejects(
      () =>
        client.uploadFile(
          'small.json',
          new Blob(['{}'], { type: 'application/json' }),
          { parents: ['folder'] },
          new AbortController().signal,
        ),
      (error: unknown) => error instanceof DriveRequestError && error.status === 500,
    );
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('missing or expired OAuth token fails before a Drive request is transmitted', async () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ files: [] });
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => null);
    await assert.rejects(
      () => client.listFiles('trashed=false', new AbortController().signal),
      DriveAuthorizationError,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Drive file listings bypass browser caches for uniqueness checks', async () => {
  let requestInit: RequestInit | undefined;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestInit = init;
    return Response.json({ files: [] });
  }) as typeof fetch;
  try {
    const client = new DriveClient(() => 'fake-google-oauth-token');
    assert.deepEqual(
      await client.listFiles('trashed=false', new AbortController().signal),
      [],
    );
    assert.equal(requestInit?.cache, 'no-store');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('401 response performs one controlled broker refresh before requiring reauthorization', async () => {
  let fetchCalls = 0;
  const tokenCalls: boolean[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: { message: 'expired' } }, { status: 401 });
  }) as typeof fetch;
  try {
    const client = new DriveClient((forceRefresh = false) => {
      tokenCalls.push(forceRefresh);
      return forceRefresh ? 'fresh-token-rejected-by-drive' : 'expired-token';
    });
    await assert.rejects(
      () => client.listFiles('trashed=false', new AbortController().signal),
      DriveAuthorizationError,
    );
    assert.equal(fetchCalls, 2);
    assert.deepEqual(tokenCalls, [false, true, false]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('403 and 404 responses are sanitized and are not retried', async () => {
  for (const expected of [
    { status: 403, message: /denied access/ },
    { status: 404, message: /could not be found/ },
  ]) {
    let fetchCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json(
        { error: { message: 'sensitive raw Google response text' } },
        { status: expected.status },
      );
    }) as typeof fetch;
    try {
      const client = new DriveClient(() => 'fake-google-oauth-token');
      await assert.rejects(
        () => client.listFiles('trashed=false', new AbortController().signal),
        (error: unknown) =>
          error instanceof DriveRequestError &&
          error.status === expected.status &&
          expected.message.test(error.message) &&
          !error.message.includes('sensitive raw Google response text'),
      );
      assert.equal(fetchCalls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }
});

test('429 and 500 responses use bounded retry and recover without exposing raw errors', async () => {
  for (const status of [429, 500]) {
    let fetchCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return Response.json(
          { error: { message: 'sensitive raw Google response text' } },
          { status },
        );
      }
      return Response.json({ files: [] });
    }) as typeof fetch;
    try {
      const client = new DriveClient(() => 'fake-google-oauth-token');
      assert.deepEqual(
        await client.listFiles('trashed=false', new AbortController().signal),
        [],
      );
      assert.equal(fetchCalls, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }
});

test('exit warning requires unsynchronized changes and an established cloud target', () => {
  assert.equal(shouldWarnBeforeUnload(false, false), false);
  assert.equal(shouldWarnBeforeUnload(true, false), false);
  assert.equal(shouldWarnBeforeUnload(false, true), false);
  assert.equal(shouldWarnBeforeUnload(true, true), true);
});

test('sync implementation is lazy, uses existing validators, and keeps only a one-time verifier in session storage', () => {
  const toolbar = source('../src/components/Toolbar.tsx');
  const appLayout = source('../src/components/AppLayout.tsx');
  const adapter = source('../src/sync/localAdapter.ts');
  const drive = source('../src/sync/driveClient.ts');
  const identity = source('../src/sync/googleIdentity.ts');
  assert.match(appLayout, /lazy\(\(\) =>\s*import\('\.\.\/sync\/PaperSyncControl'\)/);
  assert.doesNotMatch(toolbar, /PaperSyncControl/u);
  assert.match(adapter, /validateBackupDocumentState/);
  assert.match(adapter, /restoreBackupDocument/);
  assert.match(adapter, /restoreProductivityBackupData/);
  assert.doesNotMatch(
    `${adapter}\n${drive}\n${identity}`,
    /console\.(?:log|warn|error)/,
  );
  assert.doesNotMatch(
    identity,
    /localStorage|\brefresh_token\s*[:=]|client_secret|gsi\/client|initTokenClient/,
  );
  assert.match(identity, /sessionStorage\.setItem\(EXCHANGE_STORAGE_KEY/);
  assert.match(identity, /sessionStorage\.removeItem\(EXCHANGE_STORAGE_KEY/);
  assert.doesNotMatch(identity, /GoogleOAuthRealm|\/api\/v3\//u);
});

test('integrity recovery controls are semantically gated and Retry has a dedicated read-only branch', () => {
  const control = source('../src/sync/SyncControl.tsx');
  const coordinator = source('../src/sync/coordinator.ts');
  const repository = source('../src/sync/driveRepository.ts');
  assert.match(control, /state\.integrityIssue\.localRepairAvailable\s*\?\s*\(/u);
  assert.match(control, /state\.integrityIssue\.remoteMergeAvailable\s*\?\s*\(/u);
  assert.match(
    coordinator,
    /_reason === 'integrity-retry'[\s\S]*performReadOnlyIntegrityVerification[\s\S]*return;/u,
  );
  assert.match(
    coordinator,
    /!this\.integrityFailure[\s\S]*!this\.view\.integrityIssue/u,
  );
  assert.match(
    repository,
    /verifyIntegrityFailureReadOnly\([\s\S]*downloadText[\s\S]*getMetadata[\s\S]*downloadBlob/u,
  );
});

test('advanced Drive reset uses the explicit warning and a persistent ordinary-sync interlock', () => {
  const control = source('../src/sync/SyncControl.tsx');
  const coordinator = source('../src/sync/coordinator.ts');
  const repository = source('../src/sync/driveRepository.ts');
  assert.match(control, /Reset Drive sync from this device/u);
  assert.match(
    control,
    /This deletes\/replaces 39Note-managed sync data in the selected Google Drive 39Note folder and republishes the current local state\. Other Google Drive files are not affected\./u,
  );
  assert.match(control, /window\.confirm/u);
  assert.match(coordinator, /state\.resetIncomplete = true/u);
  assert.match(
    coordinator,
    /reason !== 'drive-reset'[\s\S]*this\.state\?\.resetIncomplete/u,
  );
  assert.match(repository, /requireSelectedResetRoot/u);
  assert.equal(repository.match(/\.trashManagedFileForReset\(/gu)?.length, 1);
});

test('SHA-256 hashing is stable for synced payload integrity', async () => {
  assert.equal(await sha256Hex('39Note'), await sha256Hex(new Blob(['39Note'])));
  assert.equal(
    stableStringify({ z: 1, ä: 2, a: 3, A: 4 }),
    '{"A":4,"a":3,"z":1,"ä":2}',
  );
});

test('semantic integrity preflight fails closed before persistence or repair', async (context) => {
  const { createServer } = await import('vite');
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    const { BrowserSyncLocalAdapter } = (await server.ssrLoadModule(
      '/src/sync/localAdapter.ts',
    )) as typeof import('../src/sync/localAdapter.ts');
    const { restoreProductivityBackupData } = (await server.ssrLoadModule(
      '/src/services/productivityPersistence.ts',
    )) as typeof import('../src/services/productivityPersistence.ts');
    const adapter = new BrowserSyncLocalAdapter();
    const base = snapshot([validDocumentEntity()]);
    assert.doesNotThrow(() => adapter.validateSnapshot(base));

    const invalidProductivity = {
      app: '39Note' as const,
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      entities: [
        entity(
          'print-draft',
          'doc-1',
          { documentId: 'doc-1', editorStateJson: 42 },
          2,
          'device-b',
          'e',
          'doc-1',
        ),
      ],
      tombstones: [],
    };
    const prospective = replacePayloadForContext(
      base,
      {
        logicalType: 'productivity-data',
        logicalPath: '/39Note/documents/document-doc-1/productivity.json',
        documentId: 'doc-1',
      },
      invalidProductivity,
    );
    assert.ok(prospective);

    await context.test('remote candidate is rejected by semantic validation', () => {
      assert.throws(
        () => adapter.validateSnapshot(prospective),
        /Cloud productivity data failed validation/u,
      );
      const invalidNestedConversation = replacePayloadForContext(
        base,
        {
          logicalType: 'productivity-data',
          logicalPath: '/39Note/documents/document-doc-1/productivity.json',
          documentId: 'doc-1',
        },
        {
          app: '39Note',
          syncSchemaVersion: SYNC_SCHEMA_VERSION,
          entities: [
            entity(
              'ai-conversation',
              'conversation-1',
              {
                id: 'conversation-1',
                documentId: 'doc-1',
                title: 'Invalid nested message',
                promptProfileId: 'default',
                createdAt: 1,
                updatedAt: 2,
                messages: [
                  { id: 'message-1', role: 'invalid', content: 'x', createdAt: 1 },
                ],
              },
              2,
              'device-b',
              'a',
              'doc-1',
            ),
          ],
          tombstones: [],
        },
      );
      assert.ok(invalidNestedConversation);
      assert.throws(
        () => adapter.validateSnapshot(invalidNestedConversation),
        /Cloud productivity data failed validation/u,
      );
    });
    await context.test('apply rejects before opening local persistence', async () => {
      await assert.rejects(
        () => adapter.applySnapshot(prospective, new Map()),
        /Cloud productivity data failed validation/u,
      );
    });
    await context.test('productivity restore rejects rather than skips', async () => {
      await assert.rejects(
        () =>
          restoreProductivityBackupData(
            [
              {
                documentId: 'doc-1',
                printDraft: { documentId: 'doc-1' } as never,
                aiConversations: [],
              },
            ],
            false,
          ),
        /Cloud productivity data failed validation/u,
      );
    });
  } finally {
    await server.close();
  }
});
