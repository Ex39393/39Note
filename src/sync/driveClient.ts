import type {
  DriveOperationPhaseSpan,
  DriveOperationStateTransition,
  DriveOperationTelemetrySnapshot,
  DriveSyncOperationType,
} from './driveOperationTelemetry.ts';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
const RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 4;

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  modifiedTime?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  version?: string;
  size?: string;
  trashed?: boolean;
  webViewLink?: string;
  ownedByMe?: boolean;
}

interface DriveFileList {
  files: DriveFileMetadata[];
  nextPageToken?: string;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFileMetadata;
}

interface DriveChangePage {
  changes?: unknown[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

export interface DriveChangeBatch {
  changes: DriveChange[];
  newStartPageToken: string;
  pages: number;
}

export class DriveAuthorizationError extends Error {
  constructor() {
    super('Google authorization expired. Reconnect Google Drive to continue syncing.');
    this.name = 'DriveAuthorizationError';
  }
}

export type DriveRequestFailureCode =
  | 'storage-full'
  | 'rate-limited'
  | 'permission-denied'
  | 'not-found'
  | 'precondition-failed'
  | 'backend-unavailable'
  | 'change-token-invalid'
  | 'invalid-response'
  | 'request-failed';

export type DriveRequestOperation =
  | 'list'
  | 'changes'
  | 'metadata'
  | 'download'
  | 'upload'
  | 'update'
  | 'folder'
  | 'reset'
  | 'cleanup'
  | 'remove'
  | 'unknown';

export type DriveRequestResource =
  | 'change-log'
  | 'file-list'
  | 'file-metadata'
  | 'file-content'
  | 'file-upload'
  | 'root'
  | 'paper-folder'
  | 'data-folder'
  | 'manifest'
  | 'payload'
  | 'source-pdf'
  | 'source-document'
  | 'rendered-print-pdf'
  | 'post-publish-verification'
  | 'folder'
  | 'reset'
  | 'legacy-cleanup'
  | 'control-folder'
  | 'presence'
  | 'layout-descriptor'
  | 'migration-completion'
  | 'unknown';

export interface DriveRequestContext {
  phase?: string;
  dependencyPhase?: string;
  resource?: DriveRequestResource;
  documentId?: string;
  fileId?: string;
  byteCount?: number;
  operationId?: string;
  operationType?: DriveSyncOperationType;
}

/** Redacted per-attempt diagnostics. URLs, query text, tokens, and bodies are omitted. */
export interface DriveRequestTelemetryEvent {
  phase?: string;
  dependencyPhase?: string;
  resource?: DriveRequestResource;
  byteCount?: number;
  operationId?: string;
  operationType?: DriveSyncOperationType;
  /** Operation-local identities; durable Drive/document IDs are never emitted. */
  paperCorrelationId?: string;
  fileCorrelationId?: string;
  operation: DriveRequestOperation;
  requestCategory: DriveRequestOperation;
  method: string;
  attempt: number;
  retryCount: number;
  outcome: 'success' | 'http-error' | 'network-error';
  elapsedMs: number;
  startedAtMs: number;
  endedAtMs: number;
  relativeStartMs?: number;
  relativeEndMs?: number;
  parallelWave?: number;
  bytesTransferred: number;
  status?: number;
}

export interface DriveClientOptions {
  onTelemetry?: (event: Readonly<DriveRequestTelemetryEvent>) => void;
  now?: () => number;
}

const SAFE_TELEMETRY_LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SENSITIVE_TELEMETRY_PREFIX = /^(?:bearer|ghp|sk|xox|ya29)(?:-|\.|$)/iu;
const SAFE_REQUEST_METHODS = new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
const SAFE_REQUEST_RESOURCES = new Set<string>([
  'change-log',
  'file-list',
  'file-metadata',
  'file-content',
  'file-upload',
  'root',
  'paper-folder',
  'data-folder',
  'manifest',
  'payload',
  'source-pdf',
  'source-document',
  'post-publish-verification',
  'folder',
  'reset',
  'legacy-cleanup',
  'control-folder',
  'presence',
  'layout-descriptor',
  'migration-completion',
  'unknown',
]);
const SAFE_TRANSITIONS = new Set<string>([
  'operation-owner-acquired',
  'operation-owner-released',
  'operation-issue-observed',
  'operation-retry-classified',
  'repository-remove-started',
  'repository-restore-started',
  'presence-resolved',
  'presence-upload-metadata-rejected',
  'removed-presence-published',
  'present-presence-published',
  'paper-folder-selected',
  'paper-folder-trashed',
  'paper-folder-untrashed',
  'paper-package-verified',
  'cleanup-deferred',
  'paper-state-updated',
  'paper-issue-created',
  'paper-issue-cleared',
  'changes-invalidation-classified',
  'discovery-state-applied',
]);
const SAFE_PAPER_STATES = new Set<string>([
  'cloud-only',
  'local-only',
  'synced',
  'local-changes',
  'remote-update-available',
  'both-changed',
  'downloading',
  'uploading',
  'needs-attention',
]);
const SAFE_PRESENCE_STATES = new Set<string>(['missing', 'present', 'removed']);
const SAFE_FOLDER_IDENTITIES = new Set<string>([
  'missing',
  'mismatch',
  'selected-active',
  'selected-trashed',
]);
const SAFE_TRANSITION_OUTCOMES = new Set<string>([
  'started',
  'succeeded',
  'failed',
  'deferred',
]);

function telemetryLabel(value: unknown, fallback?: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 96 ||
    !SAFE_TELEMETRY_LABEL.test(value) ||
    SENSITIVE_TELEMETRY_PREFIX.test(value)
  ) {
    return fallback;
  }
  return value;
}

function safeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export class DriveRequestError extends Error {
  readonly status: number;
  readonly code: DriveRequestFailureCode;
  readonly operation: DriveRequestOperation;
  readonly reason?: string;

  constructor(
    message: string,
    status: number,
    code: DriveRequestFailureCode = 'request-failed',
    operation: DriveRequestOperation = 'unknown',
    reason?: string,
  ) {
    super(message);
    this.name = 'DriveRequestError';
    this.status = status;
    this.code = code;
    this.operation = operation;
    this.reason = reason;
  }
}

export class DriveNetworkError extends Error {
  readonly operation: DriveRequestOperation;

  constructor(operation: DriveRequestOperation = 'unknown') {
    super('Google Drive could not be reached.');
    this.name = 'DriveNetworkError';
    this.operation = operation;
  }
}

export class DriveClient {
  private readonly getAccessToken: (
    forceRefresh?: boolean,
  ) => string | null | Promise<string | null>;
  private readonly onTelemetry?: DriveClientOptions['onTelemetry'];
  private readonly now: () => number;
  private telemetrySequence = 0;
  private activeTelemetryOperation?: ActiveDriveTelemetryOperation;
  private readonly documentTelemetryCorrelations = new Map<string, string>();
  private nextDocumentTelemetryCorrelation = 0;
  private readonly deferredResponseTelemetry = new WeakMap<
    Response,
    DeferredDriveRequestTelemetry
  >();

  constructor(
    getAccessToken: (forceRefresh?: boolean) => string | null | Promise<string | null>,
    options: DriveClientOptions = {},
  ) {
    this.getAccessToken = getAccessToken;
    this.onTelemetry = options.onTelemetry;
    this.now = options.now ?? (() => performance.now());
  }

  beginOperationTelemetry(operationType: DriveSyncOperationType): string {
    const operationId = `drive-operation-${++this.telemetrySequence}`;
    this.activeTelemetryOperation = {
      operationId,
      operationType,
      startedAtMs: this.now(),
      wave: 0,
      completedWave: 0,
      operationRetryCount: 0,
      events: [],
      phaseSpans: [],
      stateTransitions: [],
      fileCorrelations: new Map(),
      nextFileCorrelation: 0,
    };
    return operationId;
  }

  finishOperationTelemetry(
    operationId: string,
  ): DriveOperationTelemetrySnapshot | undefined {
    const active = this.activeTelemetryOperation;
    if (!active || active.operationId !== operationId) return undefined;
    this.activeTelemetryOperation = undefined;
    return Object.freeze({
      operationId: active.operationId,
      operationType: active.operationType,
      startedAtMs: active.startedAtMs,
      endedAtMs: this.now(),
      events: Object.freeze([...active.events]),
      phaseSpans: Object.freeze([...active.phaseSpans]),
      stateTransitions: Object.freeze([...active.stateTransitions]),
      operationRetryCount: active.operationRetryCount,
    });
  }

  recordOperationStateTransition(
    event: Omit<
      DriveOperationStateTransition,
      'relativeTimeMs' | 'paperCorrelationId'
    > & { documentId?: string },
  ): void {
    const active = this.activeTelemetryOperation;
    if (!active) return;
    if (!SAFE_TRANSITIONS.has(event.transition)) return;
    const paperCorrelationId = event.documentId
      ? this.paperCorrelation(event.documentId)
      : undefined;
    active.stateTransitions.push(
      Object.freeze({
        relativeTimeMs: Math.max(0, this.now() - active.startedAtMs),
        phase: telemetryLabel(event.phase, 'redacted')!,
        transition: event.transition,
        ...(paperCorrelationId ? { paperCorrelationId } : {}),
        ...(event.previousPaperState && SAFE_PAPER_STATES.has(event.previousPaperState)
          ? { previousPaperState: event.previousPaperState }
          : {}),
        ...(event.nextPaperState && SAFE_PAPER_STATES.has(event.nextPaperState)
          ? { nextPaperState: event.nextPaperState }
          : {}),
        ...(event.issueCode
          ? { issueCode: telemetryLabel(event.issueCode, 'redacted')! }
          : {}),
        ...(event.presenceState && SAFE_PRESENCE_STATES.has(event.presenceState)
          ? { presenceState: event.presenceState }
          : {}),
        ...(event.folderIdentity && SAFE_FOLDER_IDENTITIES.has(event.folderIdentity)
          ? { folderIdentity: event.folderIdentity }
          : {}),
        ...(event.outcome && SAFE_TRANSITION_OUTCOMES.has(event.outcome)
          ? { outcome: event.outcome }
          : {}),
        ...(event.classification
          ? { classification: telemetryLabel(event.classification, 'redacted')! }
          : {}),
      }),
    );
  }

  recordOperationRetry(): void {
    if (this.activeTelemetryOperation) {
      this.activeTelemetryOperation.operationRetryCount += 1;
    }
  }

  async measureOperationPhase<T>(
    phase: string,
    task: () => T | Promise<T>,
    details: { documentId?: string; bytesProcessed?: number } = {},
  ): Promise<T> {
    const active = this.activeTelemetryOperation;
    if (!active) return await task();
    const startedAtMs = this.now();
    try {
      return await task();
    } finally {
      const endedAtMs = this.now();
      if (this.activeTelemetryOperation === active) {
        const paperCorrelationId = details.documentId
          ? this.paperCorrelation(details.documentId)
          : undefined;
        const bytesProcessed = safeNonNegativeNumber(details.bytesProcessed);
        active.phaseSpans.push(
          Object.freeze({
            phase: telemetryLabel(phase, 'redacted')!,
            relativeStartMs: Math.max(0, startedAtMs - active.startedAtMs),
            relativeEndMs: Math.max(0, endedAtMs - active.startedAtMs),
            elapsedMs: Math.max(0, endedAtMs - startedAtMs),
            ...(paperCorrelationId ? { paperCorrelationId } : {}),
            ...(bytesProcessed === undefined ? {} : { bytesProcessed }),
          }),
        );
      }
    }
  }

  async listFiles(
    query: string,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata[]> {
    const files: DriveFileMetadata[] = [];
    let pageToken: string | undefined;
    do {
      const parameters = new URLSearchParams({
        q: query,
        spaces: 'drive',
        pageSize: '100',
        fields:
          'nextPageToken,files(id,name,mimeType,parents,appProperties,modifiedTime,md5Checksum,sha256Checksum,version,size,trashed,webViewLink,ownedByMe)',
      });
      if (pageToken) parameters.set('pageToken', pageToken);
      const page = await this.requestJson<unknown>(
        `${DRIVE_API}/files?${parameters.toString()}`,
        { signal, cache: 'no-store' },
        'list',
        { resource: 'file-list', ...context },
      );
      if (!isDriveFileList(page)) throw invalidDriveResponse('list');
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async getStartPageToken(signal: AbortSignal): Promise<string> {
    const response = await this.requestJson<unknown>(
      `${DRIVE_API}/changes/startPageToken?supportsAllDrives=false`,
      { signal, cache: 'no-store' },
      'changes',
      { phase: 'change-baseline', resource: 'change-log' },
    );
    if (!isRecord(response) || !isOpaquePageToken(response.startPageToken)) {
      throw invalidDriveResponse('changes');
    }
    return response.startPageToken;
  }

  /** Exhausts the feed. Callers must persist the returned token only after durable apply. */
  async listChanges(pageToken: string, signal: AbortSignal): Promise<DriveChangeBatch> {
    if (!isOpaquePageToken(pageToken)) throw invalidDriveResponse('changes');
    const changes: DriveChange[] = [];
    const visited = new Set<string>();
    let currentToken = pageToken;
    let pages = 0;
    while (true) {
      if (visited.has(currentToken)) throw invalidDriveResponse('changes');
      visited.add(currentToken);
      const parameters = new URLSearchParams({
        pageToken: currentToken,
        pageSize: '1000',
        spaces: 'drive',
        includeRemoved: 'true',
        restrictToMyDrive: 'true',
        fields:
          'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,appProperties,modifiedTime,md5Checksum,sha256Checksum,version,size,trashed,webViewLink,ownedByMe))',
      });
      const page = await this.requestJson<unknown>(
        `${DRIVE_API}/changes?${parameters.toString()}`,
        { signal, cache: 'no-store' },
        'changes',
        { phase: 'incremental-discovery', resource: 'change-log' },
      );
      if (!isDriveChangePage(page)) throw invalidDriveResponse('changes');
      pages += 1;
      for (const value of page.changes ?? []) changes.push(normalizeDriveChange(value));
      if (page.nextPageToken) {
        currentToken = page.nextPageToken;
        continue;
      }
      if (!page.newStartPageToken) throw invalidDriveResponse('changes');
      return { changes, newStartPageToken: page.newStartPageToken, pages };
    }
  }

  async getMetadata(
    fileId: string,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    const fields =
      'id,name,mimeType,parents,appProperties,modifiedTime,md5Checksum,sha256Checksum,version,size,trashed,webViewLink,ownedByMe';
    const metadata = await this.requestJson<unknown>(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`,
      { signal, cache: 'no-store' },
      'metadata',
      { resource: 'file-metadata', fileId, ...context },
    );
    if (!isDriveFileMetadata(metadata)) throw invalidDriveResponse('metadata');
    return metadata;
  }

  async createFolder(
    name: string,
    parentId: string | null,
    appProperties: Record<string, string>,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    const response = await this.request(
      `${DRIVE_API}/files?fields=id,name,mimeType,parents,appProperties,webViewLink,ownedByMe`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: 'application/vnd.google-apps.folder',
          ...(parentId ? { parents: [parentId] } : {}),
          appProperties,
        }),
      },
      [],
      'folder',
      { resource: 'folder', ...context },
    );
    return this.readFileMetadata(response, 'folder');
  }

  async updateMetadata(
    fileId: string,
    metadata: Record<string, unknown>,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    const response = await this.request(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents,appProperties,modifiedTime,version,webViewLink`,
      {
        method: 'PATCH',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      },
      [],
      'update',
      { resource: 'file-metadata', fileId, ...context },
    );
    return this.readFileMetadata(response, 'update');
  }

  async trashManagedFileForReset(
    fileId: string,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    return this.trashManagedFile(fileId, signal, 'reset', 'reset', context);
  }

  async trashManagedLegacyFile(
    fileId: string,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    return this.trashManagedFile(fileId, signal, 'cleanup', 'legacy-cleanup', context);
  }

  async trashManagedPaperFolder(
    fileId: string,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    return this.trashManagedFile(fileId, signal, 'remove', 'paper-folder', context);
  }

  /**
   * Restores one already verified managed paper-folder identity. The repository
   * owns identity validation; this method performs only the exact-id Drive
   * mutation and corrects the parent relationship in the same request.
   */
  async restoreManagedPaperFolder(
    fileId: string,
    rootFolderId: string,
    currentParents: readonly string[],
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    const parameters = new URLSearchParams({
      fields:
        'id,name,mimeType,parents,appProperties,modifiedTime,version,trashed,ownedByMe',
    });
    if (!currentParents.includes(rootFolderId)) {
      parameters.set('addParents', rootFolderId);
    }
    const obsoleteParents = currentParents.filter(
      (parentId) => parentId !== rootFolderId,
    );
    if (obsoleteParents.length > 0) {
      parameters.set('removeParents', obsoleteParents.join(','));
    }
    const response = await this.request(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${parameters.toString()}`,
      {
        method: 'PATCH',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: false }),
      },
      [],
      'update',
      { resource: 'paper-folder', fileId, ...context },
    );
    return this.readFileMetadata(response, 'update');
  }

  private async trashManagedFile(
    fileId: string,
    signal: AbortSignal,
    operation: 'reset' | 'cleanup' | 'remove',
    resource: 'reset' | 'legacy-cleanup' | 'paper-folder',
    context: DriveRequestContext,
  ): Promise<DriveFileMetadata> {
    const response = await this.request(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,parents,appProperties,modifiedTime,version,trashed`,
      {
        method: 'PATCH',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      },
      [],
      operation,
      { resource, fileId, ...context },
    );
    return this.readFileMetadata(response, operation);
  }

  async uploadFile(
    name: string,
    content: Blob,
    metadata: { parents?: string[]; appProperties?: Record<string, string> },
    signal: AbortSignal,
    onProgress?: (uploaded: number, total: number) => void,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    if (content.size > RESUMABLE_THRESHOLD) {
      return this.resumableUpload(name, content, metadata, signal, onProgress, context);
    }
    return this.multipartUpload(name, content, metadata, signal, context);
  }

  async downloadBlob(
    fileId: string,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<Blob> {
    const response = await this.request(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
      { signal, cache: 'no-store' },
      [],
      'download',
      { resource: 'file-content', fileId, ...context },
      true,
    );
    try {
      const blob = await response.blob();
      this.completeDeferredTelemetry(response, blob.size);
      return blob;
    } catch {
      this.completeDeferredTelemetry(response, 0, 'network-error');
      throw new DriveNetworkError('download');
    }
  }

  async downloadText(
    fileId: string,
    signal: AbortSignal,
    context: DriveRequestContext = {},
  ): Promise<string> {
    const response = await this.request(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
      { signal, cache: 'no-store' },
      [],
      'download',
      { resource: 'file-content', fileId, ...context },
      true,
    );
    try {
      const text = await response.text();
      this.completeDeferredTelemetry(
        response,
        new TextEncoder().encode(text).byteLength,
      );
      return text;
    } catch {
      this.completeDeferredTelemetry(response, 0, 'network-error');
      throw new DriveNetworkError('download');
    }
  }

  private async multipartUpload(
    name: string,
    content: Blob,
    metadata: { parents?: string[]; appProperties?: Record<string, string> },
    signal: AbortSignal,
    context: DriveRequestContext,
  ): Promise<DriveFileMetadata> {
    const body = new FormData();
    body.append(
      'metadata',
      new Blob([JSON.stringify({ name, ...metadata })], { type: 'application/json' }),
    );
    body.append('file', content, name);
    const url = `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,parents,appProperties,modifiedTime,md5Checksum,sha256Checksum,version,size,trashed,webViewLink,ownedByMe`;
    const response = await this.request(
      url,
      {
        method: 'POST',
        signal,
        body,
      },
      [],
      'upload',
      { resource: 'file-upload', byteCount: content.size, ...context },
    );
    return this.readFileMetadata(response, 'upload');
  }

  private async resumableUpload(
    name: string,
    content: Blob,
    metadata: { parents?: string[]; appProperties?: Record<string, string> },
    signal: AbortSignal,
    onProgress?: (uploaded: number, total: number) => void,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    const endpoint = `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,parents,appProperties,modifiedTime,md5Checksum,sha256Checksum,version,size,trashed,webViewLink,ownedByMe`;
    const initialization = await this.request(
      endpoint,
      {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': content.type || 'application/octet-stream',
          'X-Upload-Content-Length': String(content.size),
        },
        body: JSON.stringify({ name, ...metadata }),
      },
      [],
      'upload',
      // The session-creation POST carries metadata only. File bytes are counted
      // exactly once by the subsequent chunk PUT requests.
      { resource: 'file-upload', ...context },
    );
    const location = initialization.headers.get('Location');
    if (!location)
      throw new DriveRequestError(
        'Google Drive did not return a resumable upload session.',
        initialization.status,
        'invalid-response',
        'upload',
      );
    const sessionUrl = validateResumableSessionUrl(location);

    let offset = 0;
    while (offset < content.size) {
      const end = Math.min(offset + RESUMABLE_CHUNK_SIZE, content.size);
      const response = await this.request(
        sessionUrl,
        {
          method: 'PUT',
          signal,
          headers: {
            'Content-Type': content.type || 'application/octet-stream',
            'Content-Range': `bytes ${offset}-${end - 1}/${content.size}`,
          },
          body: content.slice(offset, end),
        },
        [308],
        'upload',
        { resource: 'file-upload', byteCount: end - offset, ...context },
      );
      offset = end;
      onProgress?.(offset, content.size);
      if (response.status !== 308) return this.readFileMetadata(response, 'upload');
    }
    throw new DriveRequestError(
      'Google Drive resumable upload ended without a file response.',
      500,
      'invalid-response',
      'upload',
    );
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    operation: DriveRequestOperation,
    context: DriveRequestContext = {},
  ): Promise<T> {
    const response = await this.request(url, init, [], operation, context);
    return this.readJson<T>(response, operation);
  }

  private async readJson<T>(
    response: Response,
    operation: DriveRequestOperation,
  ): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new DriveRequestError(
        'Google Drive returned an invalid response.',
        response.status,
        'invalid-response',
        operation,
      );
    }
  }

  private async readFileMetadata(
    response: Response,
    operation: DriveRequestOperation,
  ): Promise<DriveFileMetadata> {
    const metadata = await this.readJson<unknown>(response, operation);
    if (!isDriveFileMetadata(metadata)) {
      throw invalidDriveResponse(operation, response.status);
    }
    return metadata;
  }

  private async request(
    url: string,
    init: RequestInit,
    additionalSuccessStatuses: readonly number[] = [],
    operation: DriveRequestOperation = 'unknown',
    context: DriveRequestContext = {},
    deferSuccessTelemetry = false,
  ): Promise<Response> {
    const canRetryRequest = (init.method ?? 'GET').toUpperCase() !== 'POST';
    let authorizationRefreshAttempted = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const accessToken = await this.getAccessToken(false);
      if (!accessToken) throw new DriveAuthorizationError();
      let response: Response;
      const trace = this.startRequestTelemetry();
      try {
        response = await fetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            Authorization: `Bearer ${accessToken}`,
          },
        });
      } catch (error) {
        this.completeRequestTelemetry(trace, {
          context,
          operation,
          method: (init.method ?? 'GET').toUpperCase(),
          attempt: attempt + 1,
          outcome: 'network-error',
          bytesTransferred: context.byteCount ?? 0,
        });
        if (init.signal?.aborted) throw error;
        if (!canRetryRequest || attempt === MAX_ATTEMPTS - 1) {
          throw new DriveNetworkError(operation);
        }
        await retryDelay(attempt, init.signal);
        continue;
      }
      const succeeded =
        response.ok || additionalSuccessStatuses.includes(response.status);
      const completion: DriveRequestTelemetryCompletion = {
        context,
        operation,
        method: (init.method ?? 'GET').toUpperCase(),
        attempt: attempt + 1,
        outcome: succeeded ? 'success' : 'http-error',
        status: response.status,
        bytesTransferred:
          context.byteCount ??
          safeResponseByteCount(response.headers.get('Content-Length')),
      };
      if (succeeded && deferSuccessTelemetry) {
        this.deferredResponseTelemetry.set(response, { trace, completion });
      } else {
        this.completeRequestTelemetry(trace, completion);
      }
      if (succeeded) return response;
      if (response.status === 401) {
        if (!authorizationRefreshAttempted) {
          authorizationRefreshAttempted = true;
          const refreshedToken = await this.getAccessToken(true);
          if (refreshedToken) continue;
        }
        throw new DriveAuthorizationError();
      }
      const failure = await readDriveError(response);
      if (
        operation === 'changes' &&
        (response.status === 400 || response.status === 410)
      ) {
        throw new DriveRequestError(
          'The saved Google Drive change position is no longer valid.',
          response.status,
          'change-token-invalid',
          operation,
        );
      }
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        failure.code === 'rate-limited' ||
        failure.code === 'backend-unavailable';
      if (retryable && canRetryRequest && attempt < MAX_ATTEMPTS - 1) {
        await retryDelay(attempt, init.signal);
        continue;
      }
      throw new DriveRequestError(
        failure.message,
        response.status,
        failure.code,
        operation,
        failure.reason,
      );
    }
    throw new DriveRequestError(
      'Google Drive request failed after retries.',
      503,
      'backend-unavailable',
      operation,
    );
  }

  private emitTelemetry(event: DriveRequestTelemetryEvent): void {
    const frozen = Object.freeze({ ...event });
    const active = this.activeTelemetryOperation;
    if (active && active.operationId === event.operationId) active.events.push(frozen);
    try {
      this.onTelemetry?.(frozen);
    } catch {
      // Diagnostics must never alter sync behavior.
    }
  }

  private startRequestTelemetry(): DriveRequestTelemetryTrace {
    const startedAtMs = this.now();
    const active = this.activeTelemetryOperation;
    let parallelWave: number | undefined;
    if (active) {
      // A request that starts after any prior request completed belongs to a
      // later causal wave even when an unrelated slow sibling is still in flight.
      // This is a conservative dependency-depth estimate: it may overstate late
      // independent starts, but it cannot hide a real A -> B -> C waterfall.
      parallelWave = active.completedWave + 1;
      active.wave = Math.max(active.wave, parallelWave);
    }
    return { startedAtMs, active, parallelWave };
  }

  private completeRequestTelemetry(
    trace: DriveRequestTelemetryTrace,
    completion: DriveRequestTelemetryCompletion,
  ): void {
    const endedAtMs = this.now();
    if (trace.active && trace.parallelWave !== undefined) {
      trace.active.completedWave = Math.max(
        trace.active.completedWave,
        trace.parallelWave,
      );
    }
    const operationContext = trace.active
      ? {
          operationId: trace.active.operationId,
          operationType: trace.active.operationType,
          relativeStartMs: Math.max(0, trace.startedAtMs - trace.active.startedAtMs),
          relativeEndMs: Math.max(0, endedAtMs - trace.active.startedAtMs),
          parallelWave: trace.parallelWave,
        }
      : {};
    const { documentId, fileId } = completion.context;
    const correlationContext = trace.active
      ? {
          ...(documentId
            ? { paperCorrelationId: this.paperCorrelation(documentId) }
            : {}),
          ...(fileId
            ? { fileCorrelationId: this.fileCorrelation(trace.active, fileId) }
            : {}),
        }
      : {};
    const phase = telemetryLabel(completion.context.phase);
    const dependencyPhase = telemetryLabel(
      completion.context.dependencyPhase ?? completion.context.phase,
      'uncategorized',
    )!;
    const resource = SAFE_REQUEST_RESOURCES.has(completion.context.resource ?? '')
      ? completion.context.resource
      : undefined;
    const byteCount = safeNonNegativeNumber(completion.context.byteCount);
    const method = SAFE_REQUEST_METHODS.has(completion.method)
      ? completion.method
      : 'OTHER';
    const attempt =
      Number.isInteger(completion.attempt) && completion.attempt > 0
        ? completion.attempt
        : 1;
    this.emitTelemetry({
      ...(phase ? { phase } : {}),
      dependencyPhase,
      ...(resource ? { resource } : {}),
      ...(byteCount === undefined ? {} : { byteCount }),
      ...correlationContext,
      ...operationContext,
      operation: completion.operation,
      requestCategory: completion.operation,
      method,
      attempt,
      retryCount: attempt - 1,
      outcome: completion.outcome,
      elapsedMs: Math.max(0, endedAtMs - trace.startedAtMs),
      startedAtMs: trace.startedAtMs,
      endedAtMs,
      bytesTransferred: safeNonNegativeNumber(completion.bytesTransferred) ?? 0,
      ...(Number.isInteger(completion.status) &&
      completion.status! >= 100 &&
      completion.status! <= 599
        ? { status: completion.status }
        : {}),
    });
  }

  private paperCorrelation(documentId: string): string {
    const existing = this.documentTelemetryCorrelations.get(documentId);
    if (existing) return existing;
    const correlation = `paper-${++this.nextDocumentTelemetryCorrelation}`;
    this.documentTelemetryCorrelations.set(documentId, correlation);
    return correlation;
  }

  private fileCorrelation(
    active: ActiveDriveTelemetryOperation,
    fileId: string,
  ): string {
    const existing = active.fileCorrelations.get(fileId);
    if (existing) return existing;
    const correlation = `file-${++active.nextFileCorrelation}`;
    active.fileCorrelations.set(fileId, correlation);
    return correlation;
  }

  private completeDeferredTelemetry(
    response: Response,
    measuredBytes: number,
    outcome: DriveRequestTelemetryEvent['outcome'] = 'success',
  ): void {
    const pending = this.deferredResponseTelemetry.get(response);
    if (!pending) return;
    this.deferredResponseTelemetry.delete(response);
    this.completeRequestTelemetry(pending.trace, {
      ...pending.completion,
      outcome,
      bytesTransferred: Math.max(pending.completion.bytesTransferred, measuredBytes),
    });
  }
}

interface ActiveDriveTelemetryOperation {
  operationId: string;
  operationType: DriveSyncOperationType;
  startedAtMs: number;
  wave: number;
  completedWave: number;
  operationRetryCount: number;
  events: DriveRequestTelemetryEvent[];
  phaseSpans: DriveOperationPhaseSpan[];
  stateTransitions: DriveOperationStateTransition[];
  fileCorrelations: Map<string, string>;
  nextFileCorrelation: number;
}

interface DriveRequestTelemetryTrace {
  startedAtMs: number;
  active?: ActiveDriveTelemetryOperation;
  parallelWave?: number;
}

interface DriveRequestTelemetryCompletion {
  context: DriveRequestContext;
  operation: DriveRequestOperation;
  method: string;
  attempt: number;
  outcome: DriveRequestTelemetryEvent['outcome'];
  status?: number;
  bytesTransferred: number;
}

interface DeferredDriveRequestTelemetry {
  trace: DriveRequestTelemetryTrace;
  completion: DriveRequestTelemetryCompletion;
}

function safeResponseByteCount(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function validateResumableSessionUrl(value: string): string {
  let session: URL;
  try {
    session = new URL(value);
  } catch {
    throw new DriveRequestError(
      'Google Drive returned an invalid resumable upload session.',
      502,
      'invalid-response',
      'upload',
    );
  }
  if (
    session.protocol !== 'https:' ||
    session.origin !== new URL(DRIVE_UPLOAD_API).origin ||
    session.username !== '' ||
    session.password !== '' ||
    session.pathname !== '/upload/drive/v3/files' ||
    session.searchParams.get('uploadType') !== 'resumable' ||
    !session.searchParams.get('upload_id') ||
    session.hash !== ''
  ) {
    throw new DriveRequestError(
      'Google Drive returned an untrusted resumable upload session.',
      502,
      'invalid-response',
      'upload',
    );
  }
  return session.toString();
}

export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

function retryDelay(attempt: number, signal?: AbortSignal | null): Promise<void> {
  const milliseconds =
    Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

interface DriveFailure {
  code: DriveRequestFailureCode;
  message: string;
  reason?: string;
}

const STORAGE_FULL_REASONS = new Set(['storageQuotaExceeded']);
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'dailyLimitExceeded',
  'downloadQuotaExceeded',
  'quotaExceeded',
]);
const SAFE_DRIVE_REASONS = new Set([
  ...STORAGE_FULL_REASONS,
  ...RATE_LIMIT_REASONS,
  'insufficientFilePermissions',
  'appNotAuthorizedToFile',
  'domainPolicy',
  'forbidden',
  'notFound',
]);

export function normalizeDriveErrorReason(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_DRIVE_REASONS.has(value) ? value : undefined;
}

async function readDriveError(response: Response): Promise<DriveFailure> {
  const reason = await readSafeGoogleReason(response);
  if (response.status === 507 || (reason && STORAGE_FULL_REASONS.has(reason))) {
    return {
      code: 'storage-full',
      message: 'Google Drive storage is full.',
      ...(reason ? { reason } : {}),
    };
  }
  if (
    response.status === 429 ||
    (reason !== undefined && RATE_LIMIT_REASONS.has(reason))
  ) {
    return {
      code: 'rate-limited',
      message: 'Google Drive is temporarily rate-limiting sync.',
      ...(reason ? { reason } : {}),
    };
  }
  if (response.status === 403) {
    return {
      code: 'permission-denied',
      message: 'Google Drive denied access to this data.',
      ...(reason ? { reason } : {}),
    };
  }
  if (response.status === 404) {
    return {
      code: 'not-found',
      message: 'Required Google Drive data could not be found.',
      ...(reason ? { reason } : {}),
    };
  }
  if (response.status === 412) {
    return {
      code: 'precondition-failed',
      message: 'Google Drive changed while sync was publishing.',
    };
  }
  if (response.status >= 500) {
    return {
      code: 'backend-unavailable',
      message: 'Google Drive is temporarily unavailable.',
    };
  }
  return {
    code: 'request-failed',
    message: `Google Drive request failed (${response.status}).`,
    ...(reason ? { reason } : {}),
  };
}

async function readSafeGoogleReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { errors?: Array<{ reason?: unknown }> };
    };
    return body.error?.errors
      ?.map((entry) => normalizeDriveErrorReason(entry.reason))
      .find((reason): reason is string => reason !== undefined);
  } catch {
    return undefined;
  }
}

function invalidDriveResponse(
  operation: DriveRequestOperation,
  status = 200,
): DriveRequestError {
  return new DriveRequestError(
    'Google Drive returned an invalid response.',
    status,
    'invalid-response',
    operation,
  );
}

function isDriveFileList(value: unknown): value is DriveFileList {
  if (!isRecord(value) || !Array.isArray(value.files)) return false;
  if (value.nextPageToken !== undefined && typeof value.nextPageToken !== 'string') {
    return false;
  }
  return value.files.every(isDriveFileMetadata);
}

function isDriveChangePage(value: unknown): value is DriveChangePage {
  if (!isRecord(value)) return false;
  if (value.changes !== undefined && !Array.isArray(value.changes)) return false;
  return (
    (value.changes ?? []).every(isDriveChangeValue) &&
    (value.nextPageToken === undefined || isOpaquePageToken(value.nextPageToken)) &&
    (value.newStartPageToken === undefined ||
      isOpaquePageToken(value.newStartPageToken))
  );
}

function isDriveChangeValue(value: unknown): boolean {
  if (!isRecord(value) || !isOpaquePageToken(value.fileId)) return false;
  if (value.changeType !== undefined && value.changeType !== 'file') return false;
  if (value.removed !== undefined && typeof value.removed !== 'boolean') return false;
  const removed = value.removed === true;
  if (value.file === undefined) return removed;
  return isDriveFileMetadata(value.file) && value.file.id === value.fileId;
}

function normalizeDriveChange(value: unknown): DriveChange {
  if (!isDriveChangeValue(value)) throw invalidDriveResponse('changes');
  const record = value as Record<string, unknown>;
  return {
    fileId: record.fileId as string,
    removed: record.removed === true,
    ...(record.file ? { file: record.file as DriveFileMetadata } : {}),
  };
}

function isOpaquePageToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)
  );
}

function isDriveFileMetadata(value: unknown): value is DriveFileMetadata {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string'
  ) {
    return false;
  }
  if (
    value.parents !== undefined &&
    (!Array.isArray(value.parents) ||
      !value.parents.every((parent) => typeof parent === 'string'))
  ) {
    return false;
  }
  if (
    value.appProperties !== undefined &&
    (!isRecord(value.appProperties) ||
      !Object.values(value.appProperties).every(
        (property) => typeof property === 'string',
      ))
  ) {
    return false;
  }
  return (
    isOptionalString(value.modifiedTime) &&
    isOptionalString(value.md5Checksum) &&
    isOptionalString(value.sha256Checksum) &&
    isOptionalString(value.version) &&
    isOptionalString(value.size) &&
    (value.trashed === undefined || typeof value.trashed === 'boolean') &&
    isOptionalString(value.webViewLink) &&
    (value.ownedByMe === undefined || typeof value.ownedByMe === 'boolean')
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
