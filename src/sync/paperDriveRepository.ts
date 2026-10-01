import { getDocumentMimeType, type StoredDocumentSource } from '../types/document.ts';
import type { StoredRenderedPrintPdf } from '../types/productivity.ts';
import { assertValidPrintPdfBlob } from '../print/renderedPrintPdf.ts';
import {
  CloudPayloadPartitionError,
  encodeCloudPayload,
  isImmutableCloudManifest,
  parseCloudManifest,
  verifyCloudManifestGeneration,
  type CloudEntityPayload,
  type CloudPayloadReference,
} from './cloudFormat.ts';
import {
  DriveAuthorizationError,
  DriveClient,
  DriveNetworkError,
  DriveRequestError,
  escapeDriveQueryValue,
  type DriveFileMetadata,
  type DriveRequestContext,
} from './driveClient.ts';
import { compareCanonicalStrings, sha256Hex, stableStringify } from './hash.ts';
import {
  buildLegacyDriveInventory,
  driveMetadataEvidenceHash,
  type LegacyDriveCleanupResult,
  type LegacyDriveInventory,
  type LegacyDriveTreeEntry,
} from './legacyDriveHousekeeping.ts';
import {
  GoogleReauthorizationRequiredError,
  SyncBackendUnavailableError,
  SyncServiceRateLimitedError,
} from './googleIdentity.ts';
import { mergeSyncSnapshots } from './merge.ts';
import {
  assertPaperSnapshot,
  combinePaperPayloads,
  createPaperManifestGeneration,
  encodePaperConflictPayload,
  parsePaperCloudManifest,
  parsePaperConflictPayloadBlob,
  parsePaperPayloadBlob,
  partitionPaperSnapshot,
  verifyPaperManifestGeneration,
  type PaperConflictPayload,
  type PaperManifestBase,
} from './paperCloudFormat.ts';
import {
  LEGACY_PAPER_MANIFEST_STORAGE,
  LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_MANIFEST_STORAGE,
  PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_PAYLOAD_STORAGE,
  PAPER_SYNC_PROTOCOL_VERSION,
  SYNC_LAYOUT_VERSION,
  type LocalPaperPackage,
  type PaperCloudManifest,
  type PaperCloudSummary,
  type PaperDownloadResult,
  type PaperDriveFileEvidence,
  type PaperLayoutInspection,
  type PaperPublishResult,
  type PaperRestoreResult,
  type RenderedPrintPdfDescriptor,
  type PaperSyncState,
  type PaperTransferProgress,
} from './paperTypes.ts';
import {
  driveRoleForNewSource,
  sourceArtifactCacheKey,
  sourceArtifactFromLocalPackage,
  sourceArtifactFromManifest,
  sourceArtifactsHaveSameIdentity,
  storedSourceFromDescriptor,
  withoutSourceBlob,
  type ExactPaperSourceArtifact,
} from './paperSourceArtifact.ts';
import {
  isLegacyPaperRootMetadata,
  isOwnedManagedPaperRootMetadata,
  isPaperV2RootMetadata,
  isPaperV3RootMetadata,
  paperRootLayoutVersion,
} from './paperRootValidation.ts';
import {
  PAPER_PRESENCE_PROTOCOL_VERSION,
  PAPER_V3_CONTROL_ROLE,
  type PaperPresenceState,
  type PaperPresenceWriter,
  type ResolvedPaperPresence,
} from './paperPresence.ts';
import {
  PaperPresenceDriveRepository,
  PaperV3ControlIntegrityError,
  type PaperV3MigrationCompletion,
} from './paperPresenceDriveRepository.ts';
import { assertNoSecretsInSyncPayload } from './secrets.ts';
import {
  ConcurrencyGate,
  PAPER_MEDIA_CONCURRENCY,
  PAPER_METADATA_CONCURRENCY,
  PAPER_TRANSFER_CONCURRENCY,
  mapWithConcurrency,
} from './syncConcurrency.ts';
import type {
  LocalSyncSourceArtifact,
  SyncConflict,
  SyncSourceArtifactDescriptor,
  SyncSnapshot,
} from './types.ts';
import { derivePaperStatus } from './paperStateMachine.ts';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PAPER_DATA_NAME = '39Note Data';
const STATE_NAME = 'state.json';
const PRODUCTIVITY_NAME = 'productivity.json';
const CONFLICTS_NAME = 'conflicts.json';
const LEGACY_ROLES = new Set([
  'documents',
  'document',
  'manifest',
  'manifest-generation',
  'library',
  'ai-settings',
]);
const PAPER_ROLES = new Set([
  'paper-folder',
  'paper-data',
  'paper-state',
  'paper-productivity',
  'paper-conflicts',
  'paper-manifest-generation',
  'paper-layout-activation',
  'paper-source-pdf',
  'paper-source-document',
  'paper-rendered-print-pdf',
  PAPER_V3_CONTROL_ROLE,
]);

interface LoadedPaperGeneration {
  file: DriveFileMetadata;
  manifest: PaperCloudManifest;
  snapshot?: SyncSnapshot;
  conflicts?: SyncConflict[];
}

interface ResolvedPaper {
  folder: DriveFileMetadata;
  dataFolder: DriveFileMetadata;
  generations: LoadedPaperGeneration[];
  heads: LoadedPaperGeneration[];
}

interface PaperLayoutActivationRecord {
  app: '39Note';
  syncLayoutVersion: typeof LEGACY_PAPER_PACKAGE_LAYOUT_VERSION;
  paperSyncProtocolVersion: typeof PAPER_SYNC_PROTOCOL_VERSION;
  rootFolderId: string;
  paperFolderIds: string[];
  paperGenerations: Record<string, string>;
  legacyManagedFileIds: string[];
}

interface VerifiedLegacyCleanupActivation {
  legacyTopLevelIds: ReadonlySet<string>;
  migratedManifests: ReadonlyMap<string, PaperCloudManifest>;
}

interface VerifiedManifestCacheEntry {
  file: DriveFileMetadata;
  manifest: PaperCloudManifest;
}

export interface PaperScopedDiscoveryResult {
  papers: PaperCloudSummary[];
  missingDocumentIds: string[];
}

interface PaperDiscoveryOptions {
  layoutValidated?: boolean;
  reuseVerifiedManifests?: boolean;
}

interface PaperPublicationOptions {
  reconciliation?: 'merge' | 'keep-local';
  forceGeneration?: boolean;
  /** A later authoritative commit owns the final guard for an immutable no-op. */
  skipNoOpAuthorization?: boolean;
  requiredPaperFolderId?: string;
  knownFolder?: DriveFileMetadata;
  knownDataFolder?: DriveFileMetadata;
  knownResolved?: ResolvedPaper;
  knownSource?: {
    descriptor?: ExactPaperSourceArtifact;
    uploaded: boolean;
    evidence?: PaperDriveFileEvidence;
  };
}

export type PaperRepositoryErrorCode =
  | 'layout-upgrade-required'
  | 'layout-migration-incomplete'
  | 'layout-migration-proof-invalid'
  | 'unsupported-layout'
  | 'drive-root-missing'
  | 'drive-root-invalid'
  | 'ambiguous-paper-folder'
  | 'paper-integrity-failed'
  | 'paper-logical-partition-invalid'
  | 'paper-remote-changed'
  | 'paper-snapshot-unstable'
  | 'paper-source-pdf-conflict'
  | 'paper-presence-invalid'
  | 'paper-removed-from-drive';

export class PaperRepositoryError extends Error {
  constructor(
    readonly code: PaperRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaperRepositoryError';
  }
}

export class PaperLayoutUpgradeRequiredError extends PaperRepositoryError {
  constructor() {
    super(
      'layout-upgrade-required',
      'Drive layout upgrade required. Ordinary paper sync was not started.',
    );
    this.name = 'PaperLayoutUpgradeRequiredError';
  }
}

export class PaperLayoutMigrationIncompleteError extends PaperRepositoryError {
  constructor() {
    super(
      'layout-migration-incomplete',
      'The paper-centric Drive layout is incomplete. Ordinary sync is paused.',
    );
    this.name = 'PaperLayoutMigrationIncompleteError';
  }
}

export class PaperLayoutMigrationProofError extends PaperRepositoryError {
  constructor(message = 'The Drive layout migration proof is no longer valid.') {
    super('layout-migration-proof-invalid', message);
    this.name = 'PaperLayoutMigrationProofError';
  }
}

export class PaperUnsupportedLayoutError extends PaperRepositoryError {
  constructor(readonly layoutVersion?: number) {
    super(
      'unsupported-layout',
      'This Drive library was created by a newer 39Note version. Ordinary sync is paused.',
    );
    this.name = 'PaperUnsupportedLayoutError';
  }
}

export class PaperRemovedFromDriveError extends PaperRepositoryError {
  constructor(readonly documentId: string) {
    super(
      'paper-removed-from-drive',
      'This paper was removed from Google Drive. Explicit restore is required.',
    );
    this.name = 'PaperRemovedFromDriveError';
  }
}

export interface PaperLayoutMigrationProof {
  recordId: 'layout';
  rootFolderId: string;
  phase: 'publishing-papers' | 'activating-layout';
  targetDocumentIds: readonly string[];
  publishedDocumentIds: readonly string[];
  publishedGenerationIds: Readonly<Record<string, string>>;
  verifiedLegacyFileIds: readonly string[];
}

export interface PaperLayoutMigrationPublisher {
  publishPaper(
    local: LocalPaperPackage,
    state: PaperSyncState,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<PaperPublishResult>;
  verifyPublishedPapers(signal: AbortSignal): Promise<void>;
  activate(signal: AbortSignal): Promise<void>;
}

export interface PaperV3MigrationPreparation {
  controlFolderId: string;
  papers: PaperCloudSummary[];
}

export interface PaperV3MigrationSeed {
  documentId: string;
  generationId: string;
  paperFolderId: string;
  state: PaperPresenceState;
  /** Exact immutable Paper-v2 package heads verified at baseline publication. */
  packageHeadIds: string[];
}

export interface PaperCloudRemovalResult {
  cloud: PaperCloudSummary;
  cleanupPending: boolean;
  cleanupError?: string;
}

export interface PaperDownloadOperationCache {
  /** Verified content-addressed JSON payloads, shared across a bounded retry. */
  readonly verifiedPayloads: Map<string, Promise<CloudEntityPayload>>;
  readonly verifiedConflictPayloads: Map<string, Promise<PaperConflictPayload>>;
  /** Verified immutable source bytes, scoped to one user-initiated Download. */
  readonly verifiedSources: Map<string, StoredDocumentSource>;
  readonly verifiedSourceEvidence: Map<string, PaperDriveFileEvidence>;
}

export function createPaperDownloadOperationCache(): PaperDownloadOperationCache {
  return {
    verifiedPayloads: new Map(),
    verifiedConflictPayloads: new Map(),
    verifiedSources: new Map(),
    verifiedSourceEvidence: new Map(),
  };
}

export class AmbiguousManagedPaperError extends PaperRepositoryError {
  readonly documentId: string;
  readonly fileIds: string[];

  constructor(documentId: string, fileIds: readonly string[] = []) {
    super(
      'ambiguous-paper-folder',
      `Multiple managed Drive folders were found for paper ${documentId}.`,
    );
    this.name = 'AmbiguousManagedPaperError';
    this.documentId = documentId;
    this.fileIds = [...fileIds].sort(compareCanonicalStrings);
  }
}

export { AmbiguousManagedPaperError as AmbiguousPaperFolderError };

export class PaperManifestIntegrityError extends PaperRepositoryError {
  readonly documentId?: string;

  constructor(message: string, documentId?: string, cause?: unknown) {
    super('paper-integrity-failed', message, { cause });
    this.name = 'PaperManifestIntegrityError';
    this.documentId = documentId;
  }
}

export class PaperPayloadPartitionError extends PaperRepositoryError {
  readonly documentId: string;
  readonly expectedSemanticPartition: string;
  readonly actualSemanticPartitions: string[];
  readonly sourceProtocolVersion?: number;
  readonly compatibilityNormalizationAttempted: boolean;

  constructor(documentId: string, cause: CloudPayloadPartitionError) {
    super(
      'paper-logical-partition-invalid',
      'Drive paper data is in the wrong logical partition.',
      { cause },
    );
    this.name = 'PaperPayloadPartitionError';
    this.documentId = documentId;
    this.expectedSemanticPartition = cause.expectedSemanticPartition;
    this.actualSemanticPartitions = [...cause.actualSemanticPartitions];
    this.sourceProtocolVersion = cause.sourceProtocolVersion;
    this.compatibilityNormalizationAttempted =
      cause.compatibilityNormalizationAttempted;
  }
}

export type PaperRemoteChangeReason =
  | 'unspecified'
  | 'root-control-changed'
  | 'summary-missing-data-folder'
  | 'presence-snapshot-changed'
  | 'folder-snapshot-changed'
  | 'manifest-head-changed'
  | 'source-snapshot-changed';

export class PaperRemoteChangedError extends PaperRepositoryError {
  readonly documentId: string;
  readonly reason: PaperRemoteChangeReason;

  constructor(documentId: string, reason: PaperRemoteChangeReason = 'unspecified') {
    super(
      'paper-remote-changed',
      `Paper ${documentId} changed in Google Drive during this operation.`,
    );
    this.name = 'PaperRemoteChangedError';
    this.documentId = documentId;
    this.reason = reason;
  }
}

export class PaperSnapshotUnstableError extends PaperRepositoryError {
  readonly documentId: string;
  readonly lastRemoteChangeReason?: PaperRemoteChangeReason;

  constructor(documentId: string, options?: ErrorOptions) {
    super(
      'paper-snapshot-unstable',
      `Paper ${documentId} kept changing in Google Drive during scoped download retries.`,
      options,
    );
    this.name = 'PaperSnapshotUnstableError';
    this.documentId = documentId;
    if (options?.cause instanceof PaperRemoteChangedError) {
      this.lastRemoteChangeReason = options.cause.reason;
    }
  }
}

export class PaperSourcePdfConflictError extends PaperRepositoryError {
  readonly documentId: string;

  constructor(documentId: string) {
    super(
      'paper-source-pdf-conflict',
      `The source PDF for paper ${documentId} has conflicting content.`,
    );
    this.name = 'PaperSourcePdfConflictError';
    this.documentId = documentId;
  }
}

export class LegacyDriveCleanupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyDriveCleanupRefusedError';
  }
}

export interface LegacyDriveHousekeepingOptions {
  migrationInProgress: boolean;
  protectedLegacyFileIds?: readonly string[];
}

export class PaperFolderNameNormalizationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaperFolderNameNormalizationRefusedError';
  }
}

export interface PaperFolderNameNormalizationItem {
  documentId: string;
  folderId: string;
  currentName: string;
  normalizedName: string;
  folderEvidenceHash: string;
  presenceHeadIds: string[];
  packageHeadIds: string[];
}

export interface PaperFolderNameNormalizationPreview {
  rootFolderId: string;
  controlFolderId: string;
  previewId: string;
  scannedAt: number;
  candidateCount: number;
  items: PaperFolderNameNormalizationItem[];
}

export interface PaperFolderNameNormalizationResult {
  renamedFolderIds: string[];
  preview: PaperFolderNameNormalizationPreview;
}

export class PaperDriveRepository {
  private readonly now: () => number;
  private readonly presence: PaperPresenceDriveRepository;
  /** Bounds media GETs across concurrent paper operations sharing this repository. */
  private readonly mediaGate = new ConcurrencyGate(PAPER_MEDIA_CONCURRENCY);
  /** Root-scoped, non-authoritative cache; every reuse requires fresh Drive metadata. */
  private readonly verifiedManifestCache = new Map<
    string,
    VerifiedManifestCacheEntry
  >();

  constructor(
    private readonly drive: DriveClient,
    readonly rootFolderId: string,
    options: { now?: () => number } = {},
  ) {
    if (!isSafeDriveId(rootFolderId)) throw new Error('Invalid Drive root identity.');
    this.now = options.now ?? Date.now;
    this.presence = new PaperPresenceDriveRepository(drive, rootFolderId, this.now);
  }

  async detectLayout(signal: AbortSignal): Promise<PaperLayoutInspection> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'layout-validation',
      resource: 'root',
    });
    if (root.id !== this.rootFolderId || !isOwnedManagedPaperRootMetadata(root)) {
      throw new PaperRepositoryError(
        'drive-root-invalid',
        'The selected Google Drive folder is not a verified 39Note sync root.',
      );
    }
    const children = await this.listChildren(this.rootFolderId, signal, 'root');
    const legacy = children.filter((file) => isManagedRole(file, LEGACY_ROLES));
    const control = children.filter(
      (file) => file.appProperties?.role === PAPER_V3_CONTROL_ROLE,
    );
    const paper = children.filter(
      (file) => isManagedRole(file, PAPER_ROLES) && !control.includes(file),
    );
    const unknown = children.filter(
      (file) =>
        !legacy.includes(file) && !paper.includes(file) && !control.includes(file),
    );
    const detectedLayoutVersion = paperRootLayoutVersion(root);
    let state: PaperLayoutInspection['state'];
    if (
      detectedLayoutVersion !== undefined &&
      (!Number.isSafeInteger(detectedLayoutVersion) ||
        detectedLayoutVersion > SYNC_LAYOUT_VERSION)
    ) {
      state = 'unsupported-layout';
    } else if (isPaperV3RootMetadata(root)) {
      try {
        await this.presence.verifyActivatedControl(
          root.appProperties!.controlFolderId,
          root.appProperties!.migrationCompletionId,
          signal,
        );
        state = 'paper-v3';
      } catch (error) {
        if (isDriveOperationFailure(error)) throw error;
        state = 'migration-incomplete';
      }
    } else if (detectedLayoutVersion === SYNC_LAYOUT_VERSION) {
      state = 'migration-incomplete';
    } else if (isPaperV2RootMetadata(root)) {
      state = control.length > 0 ? 'migration-incomplete' : 'paper-v2-upgrade-required';
    } else if (isLegacyPaperRootMetadata(root)) {
      state =
        paper.length > 0 || control.length > 0
          ? 'migration-incomplete'
          : 'legacy-upgrade-required';
    } else if (
      detectedLayoutVersion !== undefined ||
      paper.length > 0 ||
      control.length > 0
    ) {
      state = 'migration-incomplete';
    } else {
      state = legacy.length > 0 ? 'legacy-upgrade-required' : 'empty';
    }
    return {
      rootFolderId: root.id,
      state,
      legacyManagedFileIds: legacy.map(({ id }) => id).sort(compareCanonicalStrings),
      paperManagedFileIds: paper.map(({ id }) => id).sort(compareCanonicalStrings),
      controlManagedFileIds: control.map(({ id }) => id).sort(compareCanonicalStrings),
      unknownFileIds: unknown.map(({ id }) => id).sort(compareCanonicalStrings),
      ...(detectedLayoutVersion !== undefined &&
      Number.isSafeInteger(detectedLayoutVersion)
        ? { detectedLayoutVersion }
        : {}),
    };
  }

  /**
   * Read-only preview for the explicit folder-name maintenance action. Only an
   * owned folder selected by current present-presence and backed by one verified
   * immutable package head can enter the preview.
   */
  async inspectPaperFolderNames(
    signal: AbortSignal,
  ): Promise<PaperFolderNameNormalizationPreview> {
    const root = await this.requireActiveV3Root(signal);
    const controlFolderId = root.appProperties!.controlFolderId;
    const [presenceByDocument, folders] = await Promise.all([
      this.presence.resolveAll(controlFolderId, signal, {
        controlValidated: true,
      }),
      this.listPaperFolders(signal),
    ]);
    const grouped = groupByDocumentId(folders);
    const verifiedScope = (
      await mapWithConcurrency(
        [...presenceByDocument.entries()].sort(([first], [second]) =>
          compareCanonicalStrings(first, second),
        ),
        PAPER_METADATA_CONCURRENCY,
        async ([documentId, presence]) => {
          signal.throwIfAborted();
          if (presence.state !== 'present' || !presence.paperFolderId) return undefined;
          const matches = grouped.get(documentId) ?? [];
          if (
            matches.length !== 1 ||
            matches[0].id !== presence.paperFolderId ||
            matches[0].ownedByMe !== true
          ) {
            return undefined;
          }
          const folder = matches[0];
          let resolved: ResolvedPaper;
          try {
            resolved = await this.resolvePaperFolder(
              folder,
              signal,
              false,
              undefined,
              true,
            );
          } catch (error) {
            if (isDriveOperationFailure(error)) throw error;
            return undefined;
          }
          if (resolved.heads.length !== 1) return undefined;
          return {
            documentId,
            folderId: folder.id,
            currentName: folder.name,
            normalizedName: normalizePaperFolderName(folder.name),
            folderEvidenceHash: await driveMetadataEvidenceHash(folder),
            presenceHeadIds: [...presence.headIds].sort(compareCanonicalStrings),
            packageHeadIds: resolved.heads
              .map(({ manifest }) => manifest.generation.id)
              .sort(compareCanonicalStrings),
          } satisfies PaperFolderNameNormalizationItem;
        },
      )
    ).filter((item): item is PaperFolderNameNormalizationItem => item !== undefined);
    const items = verifiedScope.filter(
      ({ currentName, normalizedName }) => currentName !== normalizedName,
    );
    const previewId = await sha256Hex(
      stableStringify({
        rootFolderId: this.rootFolderId,
        controlFolderId,
        rootEvidenceHash: await driveMetadataEvidenceHash(root),
        verifiedScope,
      }),
    );
    return {
      rootFolderId: this.rootFolderId,
      controlFolderId,
      previewId,
      scannedAt: this.now(),
      candidateCount: items.length,
      items,
    };
  }

  /**
   * Applies exactly the confirmed cosmetic preview. Every target's root ancestry,
   * presence heads, package head, and complete folder metadata are revalidated
   * before a name-only PATCH, then identity/parent/appProperties are checked again.
   */
  async normalizePaperFolderNames(
    expected: PaperFolderNameNormalizationPreview,
    signal: AbortSignal,
  ): Promise<PaperFolderNameNormalizationResult> {
    if (expected.rootFolderId !== this.rootFolderId) {
      throw new PaperFolderNameNormalizationRefusedError(
        'The folder-name preview belongs to a different Drive root. Preview again.',
      );
    }
    const fresh = await this.inspectPaperFolderNames(signal);
    if (
      fresh.previewId !== expected.previewId ||
      fresh.controlFolderId !== expected.controlFolderId ||
      fresh.candidateCount !== expected.candidateCount
    ) {
      throw new PaperFolderNameNormalizationRefusedError(
        'Drive contents changed after the folder-name preview. Preview again.',
      );
    }
    const expectedById = new Map(expected.items.map((item) => [item.folderId, item]));
    if (
      expectedById.size !== expected.items.length ||
      !sameStringSet(
        fresh.items.map(({ folderId }) => folderId),
        expected.items.map(({ folderId }) => folderId),
      )
    ) {
      throw new PaperFolderNameNormalizationRefusedError(
        'The confirmed folder-name scope is ambiguous. Preview again.',
      );
    }

    const renamedFolderIds: string[] = [];
    for (const previewItem of expected.items) {
      signal.throwIfAborted();
      const matchingFreshItem = fresh.items.find(
        ({ folderId }) => folderId === previewItem.folderId,
      );
      if (
        !matchingFreshItem ||
        stableStringify(matchingFreshItem) !== stableStringify(previewItem)
      ) {
        throw new PaperFolderNameNormalizationRefusedError(
          'A paper folder changed after confirmation. Remaining names were preserved.',
        );
      }
      const root = await this.requireActiveV3Root(signal);
      const controlFolderId = root.appProperties!.controlFolderId;
      if (controlFolderId !== expected.controlFolderId) {
        throw new PaperFolderNameNormalizationRefusedError(
          'The Drive control area changed after confirmation. Remaining names were preserved.',
        );
      }
      const [presence, folder] = await Promise.all([
        this.presence.resolveDocument(controlFolderId, previewItem.documentId, signal, {
          controlValidated: true,
        }),
        this.drive.getMetadata(previewItem.folderId, signal, {
          phase: 'paper-folder-name-normalization-preflight',
          resource: 'paper-folder',
          documentId: previewItem.documentId,
        }),
      ]);
      if (
        !presence ||
        presence.state !== 'present' ||
        presence.paperFolderId !== previewItem.folderId ||
        !sameStringSet(presence.headIds, previewItem.presenceHeadIds) ||
        folder.ownedByMe !== true ||
        !isPaperFolder(folder, this.rootFolderId, previewItem.documentId) ||
        folder.name !== previewItem.currentName ||
        (await driveMetadataEvidenceHash(folder)) !== previewItem.folderEvidenceHash
      ) {
        throw new PaperFolderNameNormalizationRefusedError(
          'A paper folder or its current presence changed after confirmation. Remaining names were preserved.',
        );
      }
      const resolved = await this.resolvePaperFolder(
        folder,
        signal,
        false,
        undefined,
        true,
      );
      const packageHeadIds = resolved.heads
        .map(({ manifest }) => manifest.generation.id)
        .sort(compareCanonicalStrings);
      if (
        resolved.heads.length !== 1 ||
        !sameStringSet(packageHeadIds, previewItem.packageHeadIds)
      ) {
        throw new PaperFolderNameNormalizationRefusedError(
          'A paper package changed after confirmation. Remaining names were preserved.',
        );
      }

      await this.drive.updateMetadata(
        folder.id,
        { name: previewItem.normalizedName },
        signal,
        {
          phase: 'paper-folder-name-normalization',
          resource: 'paper-folder',
          documentId: previewItem.documentId,
        },
      );
      const verified = await this.drive.getMetadata(folder.id, signal, {
        phase: 'paper-folder-name-normalization-verification',
        resource: 'paper-folder',
        documentId: previewItem.documentId,
      });
      if (
        verified.id !== folder.id ||
        verified.name !== previewItem.normalizedName ||
        verified.mimeType !== folder.mimeType ||
        verified.ownedByMe !== true ||
        verified.trashed === true ||
        !sameStringSet(verified.parents ?? [], folder.parents ?? []) ||
        stableStringify(verified.appProperties ?? {}) !==
          stableStringify(folder.appProperties ?? {}) ||
        verified.appProperties?.documentId !== previewItem.documentId
      ) {
        throw new PaperFolderNameNormalizationRefusedError(
          'Google Drive did not retain a name-only paper folder update.',
        );
      }
      renamedFolderIds.push(folder.id);
    }

    return {
      renamedFolderIds,
      preview: await this.inspectPaperFolderNames(signal),
    };
  }

  /** Read-only, root-bounded inventory. No Drive mutation is reachable here. */
  async inspectLegacyDriveData(
    options: LegacyDriveHousekeepingOptions,
    signal: AbortSignal,
  ): Promise<LegacyDriveInventory> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'legacy-inventory',
      resource: 'root',
    });
    if (root.id !== this.rootFolderId || !isOwnedManagedPaperRootMetadata(root)) {
      throw new PaperRepositoryError(
        'drive-root-invalid',
        'The selected Google Drive folder is not a verified 39Note sync root.',
      );
    }
    const activePaperLayout = isPaperV3RootMetadata(root);
    const entries = await this.listLegacyInventoryTree(signal);
    let currentDataVerified = activePaperLayout;
    let currentReferenceIds: string[] = [];
    let migrationActivationVerified = false;
    let supersededLegacyFileIds: string[] = [];
    if (activePaperLayout) {
      try {
        const papers = await this.discover(undefined, signal, {
          layoutValidated: true,
          reuseVerifiedManifests: false,
        });
        currentDataVerified =
          papers.length > 0 && papers.every((paper) => !paper.issue);
        currentReferenceIds = [
          ...new Set(papers.flatMap((paper) => paper.managedFileIds ?? [])),
        ].sort(compareCanonicalStrings);
        if (currentDataVerified) {
          const activation = await this.verifyLegacyCleanupActivation(
            entries,
            papers,
            signal,
          );
          migrationActivationVerified = activation !== null;
          if (activation) {
            supersededLegacyFileIds = await this.findSupersededLegacyFiles(
              entries,
              activation,
              signal,
            );
          }
        }
      } catch (error) {
        if (isDriveOperationFailure(error)) throw error;
        currentDataVerified = false;
      }
    }
    return buildLegacyDriveInventory(this.rootFolderId, entries, {
      activePaperLayout,
      currentDataVerified,
      migrationActivationVerified,
      supersededLegacyFileIds,
      currentReferenceIds,
      protectedLegacyFileIds: options.protectedLegacyFileIds,
      migrationInProgress: options.migrationInProgress,
      now: this.now(),
    });
  }

  /**
   * Manually trashes only inventory-proven legacy items. The displayed inventory
   * is re-created before the first mutation. Only individual verified files are
   * eligible; folders stay preserved so concurrent children cannot be affected.
   */
  async cleanupLegacyDriveData(
    expected: LegacyDriveInventory,
    options: LegacyDriveHousekeepingOptions,
    signal: AbortSignal,
    refreshOptions?: () => Promise<LegacyDriveHousekeepingOptions>,
  ): Promise<LegacyDriveCleanupResult> {
    if (expected.rootFolderId !== this.rootFolderId) {
      throw new LegacyDriveCleanupRefusedError(
        'The legacy inventory belongs to a different Drive folder. Check again.',
      );
    }
    const initialOptions = refreshOptions ? await refreshOptions() : options;
    if (!sameLegacyProtectionOptions(options, initialOptions)) {
      throw new LegacyDriveCleanupRefusedError(
        'Migration or recovery state changed after the legacy check. Check again.',
      );
    }
    await this.verifyCurrentPaperPayloads(signal);
    let inventory = await this.inspectLegacyDriveData(initialOptions, signal);
    if (inventory.inventoryId !== expected.inventoryId) {
      throw new LegacyDriveCleanupRefusedError(
        'Drive contents changed after the legacy check. Check again before cleanup.',
      );
    }
    if (inventory.cleanupBlockedReason) {
      throw new LegacyDriveCleanupRefusedError(inventory.cleanupBlockedReason);
    }
    if (inventory.cleanupEligibleCount === 0) {
      throw new LegacyDriveCleanupRefusedError(
        'No positively identified legacy Drive data is eligible for cleanup.',
      );
    }
    const authorizedTargets = new Map(
      expected.items
        .filter(({ cleanupEligible, kind }) => cleanupEligible && kind === 'file')
        .map(({ id, evidenceHash }) => [id, evidenceHash]),
    );
    if (!sameStringSet([...authorizedTargets.keys()], expected.cleanupTargetIds)) {
      throw new LegacyDriveCleanupRefusedError(
        'The confirmed legacy inventory does not contain a safe file-only cleanup scope.',
      );
    }
    const trashedIds: string[] = [];
    for (const fileId of expected.cleanupTargetIds) {
      signal.throwIfAborted();
      const latestOptions = refreshOptions ? await refreshOptions() : initialOptions;
      if (!sameLegacyProtectionOptions(initialOptions, latestOptions)) {
        throw new LegacyDriveCleanupRefusedError(
          'Migration or recovery state changed during cleanup. Remaining data was preserved.',
        );
      }
      inventory = await this.inspectLegacyDriveData(latestOptions, signal);
      assertInventoryMatchesConfirmedScope(inventory, expected, trashedIds);
      const authorizedHash = authorizedTargets.get(fileId);
      const expectedItem = inventory.items.find((item) => item.id === fileId);
      if (
        !authorizedHash ||
        !expectedItem?.cleanupEligible ||
        expectedItem.kind !== 'file' ||
        expectedItem.evidenceHash !== authorizedHash
      ) {
        throw new LegacyDriveCleanupRefusedError(
          'Legacy cleanup evidence changed. Remaining data was preserved.',
        );
      }
      await this.verifyLegacyCleanupAncestry(fileId, expected, signal);
      const trashed = await this.drive.trashManagedLegacyFile(fileId, signal, {
        phase: 'legacy-cleanup',
        resource: 'legacy-cleanup',
      });
      if (trashed.id !== fileId || trashed.trashed !== true) {
        throw new LegacyDriveCleanupRefusedError(
          'Google Drive did not confirm that a recognized legacy item was moved to Trash.',
        );
      }
      trashedIds.push(fileId);
    }
    const finalOptions = refreshOptions ? await refreshOptions() : initialOptions;
    if (!sameLegacyProtectionOptions(initialOptions, finalOptions)) {
      throw new LegacyDriveCleanupRefusedError(
        'Migration or recovery state changed during cleanup. Post-cleanup verification is required.',
      );
    }
    inventory = await this.inspectLegacyDriveData(finalOptions, signal);
    assertInventoryMatchesConfirmedScope(inventory, expected, trashedIds);
    if (inventory.cleanupEligibleCount > 0) {
      throw new LegacyDriveCleanupRefusedError(
        'Post-cleanup verification found confirmed legacy files still active.',
      );
    }
    await this.verifyCurrentPaperPayloads(signal);
    return {
      inventory,
      trashedIds: trashedIds.sort(compareCanonicalStrings),
    };
  }

  async initializeEmptyLayout(signal: AbortSignal): Promise<void> {
    const inspection = await this.detectLayout(signal);
    if (inspection.state === 'paper-v3') return;
    if (
      inspection.state === 'legacy-upgrade-required' ||
      inspection.state === 'paper-v2-upgrade-required'
    ) {
      throw new PaperLayoutUpgradeRequiredError();
    }
    if (inspection.state === 'migration-incomplete') {
      throw new PaperLayoutMigrationIncompleteError();
    }
    if (inspection.state === 'unsupported-layout') {
      throw new PaperUnsupportedLayoutError(inspection.detectedLayoutVersion);
    }
    const control = await this.presence.createOrVerifyControlFolder(signal);
    const completion = await this.presence.ensureMigrationCompletion(
      control.id,
      {},
      '39note-system',
      signal,
      0,
    );
    await this.activateV3RootMetadata(control.id, completion.id, signal, true);
  }

  private async activateRebuiltLayout(
    proof: Readonly<PaperLayoutMigrationProof>,
    signal: AbortSignal,
  ): Promise<void> {
    const inspection = await this.detectLayout(signal);
    if (inspection.state === 'paper-v2-upgrade-required') return;
    if (inspection.state === 'empty') {
      throw new PaperLayoutMigrationIncompleteError();
    }
    if (!sameStringSet(inspection.legacyManagedFileIds, proof.verifiedLegacyFileIds)) {
      throw new PaperRemoteChangedError('layout');
    }
    const paperFolders = await this.listPaperFolders(signal);
    if (paperFolders.length === 0) {
      throw new PaperLayoutMigrationIncompleteError();
    }
    const activation = {
      app: '39Note' as const,
      syncLayoutVersion: LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
      paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
      rootFolderId: this.rootFolderId,
      paperFolderIds: paperFolders.map(({ id }) => id).sort(compareCanonicalStrings),
      paperGenerations: Object.fromEntries(
        Object.entries(proof.publishedGenerationIds).sort(([first], [second]) =>
          compareCanonicalStrings(first, second),
        ),
      ),
      legacyManagedFileIds: [...proof.verifiedLegacyFileIds].sort(
        compareCanonicalStrings,
      ),
    };
    const text = stableStringify(activation);
    const sha256 = await sha256Hex(text);
    const name = `paper-layout-v${LEGACY_PAPER_PACKAGE_LAYOUT_VERSION}-${sha256}.json`;
    const query = [
      `'${escapeDriveQueryValue(this.rootFolderId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
      `appProperties has { key='role' and value='paper-layout-activation' }`,
    ].join(' and ');
    let activationFile = (await this.drive.listFiles(query, signal)).find(
      (file) =>
        file.parents?.length === 1 &&
        file.parents[0] === this.rootFolderId &&
        file.appProperties?.sha256 === sha256,
    );
    if (activationFile) {
      if ((await this.drive.downloadText(activationFile.id, signal)) !== text) {
        throw new PaperManifestIntegrityError(
          'The existing Drive layout activation marker is invalid.',
        );
      }
    } else {
      activationFile = await this.drive.uploadFile(
        name,
        new Blob([text], { type: 'application/json' }),
        {
          parents: [this.rootFolderId],
          appProperties: {
            ...paperAppProperties(
              'paper-layout-activation',
              'layout',
              LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
            ),
            sha256,
          },
        },
        signal,
      );
      const [verifiedText, metadata] = await Promise.all([
        this.drive.downloadText(activationFile.id, signal),
        this.drive.getMetadata(activationFile.id, signal),
      ]);
      if (
        verifiedText !== text ||
        metadata.trashed ||
        metadata.parents?.length !== 1 ||
        metadata.parents[0] !== this.rootFolderId ||
        metadata.appProperties?.role !== 'paper-layout-activation' ||
        metadata.appProperties.sha256 !== sha256
      ) {
        throw new PaperManifestIntegrityError(
          'Google Drive did not retain the exact layout activation marker.',
        );
      }
    }
    await this.verifyLayoutMigrationPapers(proof, signal);
    await this.activateRootMetadata(signal);
  }

  async discover(
    states: readonly PaperSyncState[] | undefined,
    signal: AbortSignal,
    options: PaperDiscoveryOptions = {},
  ): Promise<PaperCloudSummary[]> {
    if (!options.layoutValidated) await this.ensureUsableLayout(signal);
    return this.discoverPresenceAware(states, signal, undefined, options);
  }

  /** Read-only Paper-v2 package discovery used only by the explicit v2 -> v3 cutover. */
  async discoverV2ForMigration(
    states: readonly PaperSyncState[] | undefined,
    signal: AbortSignal,
  ): Promise<PaperCloudSummary[]> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'v3-migration-preflight',
      resource: 'root',
    });
    if (!isPaperV2RootMetadata(root)) {
      const version = paperRootLayoutVersion(root);
      if (
        version !== undefined &&
        Number.isSafeInteger(version) &&
        version > SYNC_LAYOUT_VERSION
      ) {
        throw new PaperUnsupportedLayoutError(version);
      }
      throw new PaperLayoutMigrationProofError(
        'The selected Drive root is not an exact Paper-v2 layout.',
      );
    }
    return this.discoverPhysicalPapers(states, signal, {});
  }

  private async discoverPhysicalPapers(
    states: readonly PaperSyncState[] | undefined,
    signal: AbortSignal,
    options: PaperDiscoveryOptions = {},
  ): Promise<PaperCloudSummary[]> {
    const folders = await this.listPaperFolders(signal);
    const grouped = groupByDocumentId(folders);
    const stateByDocument = new Map(
      (states ?? []).map((state) => [state.documentId, state]),
    );
    return mapWithConcurrency(
      [...grouped.entries()].sort(([first], [second]) =>
        compareCanonicalStrings(first, second),
      ),
      PAPER_METADATA_CONCURRENCY,
      async ([documentId, matches]) => {
        signal.throwIfAborted();
        const state = stateByDocument.get(documentId);
        if (matches.length !== 1) {
          const error = new AmbiguousManagedPaperError(
            documentId,
            matches.map(({ id }) => id),
          );
          return failedPaperSummary(matches[0], documentId, state, error);
        }
        try {
          const resolved = await this.resolvePaperFolder(
            matches[0],
            signal,
            false,
            undefined,
            options.reuseVerifiedManifests === true,
          );
          return await this.summaryForResolved(resolved, state);
        } catch (error) {
          if (isDriveOperationFailure(error)) throw error;
          return failedPaperSummary(matches[0], documentId, state, error);
        }
      },
    );
  }

  /**
   * Re-resolves only invalidated semantic papers. Change records are never used as
   * heads; the immutable manifest set is queried and validated again here.
   */
  async discoverPapers(
    documentIds: readonly string[],
    states: readonly PaperSyncState[] | undefined,
    signal: AbortSignal,
    options: PaperDiscoveryOptions = {},
  ): Promise<PaperScopedDiscoveryResult> {
    if (!options.layoutValidated) await this.ensureUsableLayout(signal);
    const requested = [...new Set(documentIds)].sort(compareCanonicalStrings);
    const papers = await this.discoverPresenceAware(states, signal, requested, {
      ...options,
      // Scoped invalidation always performs fresh Drive metadata reads, so a
      // byte-identical immutable manifest can safely reuse its verified parse.
      reuseVerifiedManifests: options.reuseVerifiedManifests !== false,
    });
    const found = new Set(papers.map(({ documentId }) => documentId));
    return {
      papers,
      missingDocumentIds: requested.filter((documentId) => !found.has(documentId)),
    };
  }

  private async discoverPresenceAware(
    states: readonly PaperSyncState[] | undefined,
    signal: AbortSignal,
    requestedDocumentIds: readonly string[] | undefined,
    options: PaperDiscoveryOptions,
  ): Promise<PaperCloudSummary[]> {
    const root = await this.requireActiveV3Root(signal, !options.layoutValidated);
    const controlFolderId = root.appProperties!.controlFolderId;
    let presenceByDocument: Map<string, ResolvedPaperPresence>;
    try {
      if (requestedDocumentIds) {
        const resolved = await mapWithConcurrency(
          requestedDocumentIds,
          PAPER_METADATA_CONCURRENCY,
          async (documentId) =>
            [
              documentId,
              await this.presence.resolveDocument(controlFolderId, documentId, signal, {
                controlValidated: true,
              }),
            ] as const,
        );
        presenceByDocument = new Map(
          resolved.filter(
            (entry): entry is readonly [string, ResolvedPaperPresence] =>
              entry[1] !== null,
          ),
        );
      } else {
        presenceByDocument = await this.presence.resolveAll(controlFolderId, signal, {
          controlValidated: true,
        });
      }
    } catch (error) {
      if (isDriveOperationFailure(error)) throw error;
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'The Drive paper-presence control data needs verification.',
        { cause: error },
      );
    }
    const folders = requestedDocumentIds
      ? (
          await mapWithConcurrency(
            requestedDocumentIds,
            PAPER_METADATA_CONCURRENCY,
            (documentId) => this.listPaperFolders(signal, documentId),
          )
        ).flat()
      : await this.listPaperFolders(signal);
    const grouped = groupByDocumentId(folders);
    const stateByDocument = new Map(
      (states ?? []).map((state) => [state.documentId, state]),
    );
    const documentIds = (
      requestedDocumentIds ?? [
        ...new Set([...presenceByDocument.keys(), ...grouped.keys()]),
      ]
    )
      .slice()
      .sort(compareCanonicalStrings);

    return mapWithConcurrency(
      documentIds,
      PAPER_METADATA_CONCURRENCY,
      async (documentId) => {
        signal.throwIfAborted();
        const presence = presenceByDocument.get(documentId);
        const matches = grouped.get(documentId) ?? [];
        const state = stateByDocument.get(documentId);
        if (!presence) {
          if (matches.length === 0) return undefined;
          return failedPaperSummary(
            matches[0],
            documentId,
            state,
            new PaperRepositoryError(
              'paper-presence-invalid',
              'A v3 paper folder has no authoritative presence state.',
            ),
          );
        }
        if (presence.state === 'removed') {
          const recognizedTarget = matches.filter(
            (folder) => folder.id === presence.paperFolderId,
          );
          const ambiguousCleanup =
            !presence.paperFolderId ||
            matches.some((folder) => folder.id !== presence.paperFolderId) ||
            recognizedTarget.length > 1;
          return removedPaperSummary(presence, state, matches, ambiguousCleanup);
        }
        if (
          !presence.paperFolderId ||
          matches.length !== 1 ||
          matches[0].id !== presence.paperFolderId
        ) {
          const folder = matches[0] ?? presenceFolderPlaceholder(presence);
          return failedPaperSummary(
            folder,
            documentId,
            state,
            new PaperRepositoryError(
              matches.length > 1 ? 'ambiguous-paper-folder' : 'paper-presence-invalid',
              'The present paper does not have one exact recognized folder.',
            ),
          );
        }
        try {
          const resolved = await this.resolvePaperFolder(
            matches[0],
            signal,
            false,
            undefined,
            options.reuseVerifiedManifests === true,
          );
          const summary = await this.summaryForResolved(resolved, state);
          return {
            ...summary,
            presenceState: 'present' as const,
            presenceHeadIds: presence.headIds,
            managedFileIds: [
              ...(summary.managedFileIds ?? []),
              ...(presence.managedFileIds ?? []),
            ].filter((id, index, values) => values.indexOf(id) === index),
          };
        } catch (error) {
          if (isDriveOperationFailure(error)) throw error;
          return failedPaperSummary(matches[0], documentId, state, error);
        }
      },
    ).then((papers) =>
      papers.filter((paper): paper is PaperCloudSummary => paper !== undefined),
    );
  }

  /** Cheap root guard for the incremental path; it does not walk root children. */
  async assertActiveRoot(signal: AbortSignal): Promise<void> {
    await this.requireActiveV3Root(signal);
  }

  private async requireActiveV3Root(
    signal: AbortSignal,
    verifyControl = true,
    context: DriveRequestContext = {},
  ): Promise<DriveFileMetadata> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'root-validation',
      dependencyPhase: 'root-layout-guard',
      ...context,
      resource: 'root',
    });
    const detected = paperRootLayoutVersion(root);
    if (
      root.id === this.rootFolderId &&
      isOwnedManagedPaperRootMetadata(root) &&
      detected !== undefined &&
      Number.isSafeInteger(detected) &&
      detected > SYNC_LAYOUT_VERSION
    ) {
      throw new PaperUnsupportedLayoutError(detected);
    }
    if (root.id !== this.rootFolderId || !isPaperV3RootMetadata(root)) {
      throw new PaperRepositoryError(
        'drive-root-invalid',
        'The selected Google Drive folder is not an active 39Note sync root.',
      );
    }
    if (verifyControl) {
      try {
        await this.presence.verifyActivatedControl(
          root.appProperties!.controlFolderId,
          root.appProperties!.migrationCompletionId,
          signal,
        );
      } catch (error) {
        if (isDriveOperationFailure(error)) throw error;
        throw new PaperRepositoryError(
          'paper-presence-invalid',
          'The Drive paper-presence control data needs verification.',
          { cause: error },
        );
      }
    }
    return root;
  }

  private async assertControlRootGuard(
    controlFolderId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const root = await this.requireActiveV3Root(signal, false, {
      phase: 'presence-commit-guard',
      dependencyPhase: 'commit-guard',
      documentId,
    });
    if (root.appProperties!.controlFolderId !== controlFolderId) {
      throw new PaperRemoteChangedError(documentId);
    }
  }

  async downloadPaper(
    summary: PaperCloudSummary,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
    localState?: PaperSyncState,
    hasReusableStoredSource = false,
    operationCache?: PaperDownloadOperationCache,
  ): Promise<PaperDownloadResult> {
    if (summary.presenceState === 'removed') {
      throw new PaperRemovedFromDriveError(summary.documentId);
    }
    onProgress?.({
      documentId: summary.documentId,
      phase: 'resolving',
      detail: 'Resolving immutable paper heads',
    });
    // A Download is scoped to one paper, but its snapshot is authoritative only
    // beneath the currently activated root/control/layout boundary.
    const root = await this.requireActiveV3Root(signal, true, {
      phase: 'download-root-validation',
      dependencyPhase: 'root-layout-guard',
      documentId: summary.documentId,
    });
    const controlFolderId = root.appProperties!.controlFolderId;
    if (!summary.dataFolderId) {
      throw new PaperRemoteChangedError(
        summary.documentId,
        'summary-missing-data-folder',
      );
    }
    const [presence, folder, dataFolder] = await Promise.all([
      this.presence.resolveDocument(controlFolderId, summary.documentId, signal, {
        controlValidated: true,
      }),
      this.drive.getMetadata(summary.paperFolderId, signal, {
        phase: 'download-snapshot',
        resource: 'paper-folder',
        documentId: summary.documentId,
      }),
      this.drive.getMetadata(summary.dataFolderId, signal, {
        phase: 'download-snapshot',
        resource: 'data-folder',
        documentId: summary.documentId,
      }),
    ]);
    if (!presence || presence.state === 'removed') {
      throw new PaperRemovedFromDriveError(summary.documentId);
    }
    if (
      presence.paperFolderId !== summary.paperFolderId ||
      (summary.presenceHeadIds &&
        !sameStringSet(presence.headIds, summary.presenceHeadIds))
    ) {
      throw new PaperRemoteChangedError(
        summary.documentId,
        'presence-snapshot-changed',
      );
    }
    if (
      !isPaperFolder(folder, this.rootFolderId, summary.documentId) ||
      !isPaperDataFolder(dataFolder, folder.id, summary.documentId)
    ) {
      throw new PaperRemoteChangedError(summary.documentId, 'folder-snapshot-changed');
    }
    let resolved = await this.resolvePaperFolder(
      folder,
      signal,
      false,
      dataFolder,
      true,
    );
    const selectedHeadIds = resolved.heads
      .map(({ manifest }) => manifest.generation.id)
      .sort(compareCanonicalStrings);
    if (!sameStringSet(selectedHeadIds, summary.headIds)) {
      throw new PaperRemoteChangedError(summary.documentId, 'manifest-head-changed');
    }
    const remoteSourceDescriptors = resolved.heads.flatMap(({ manifest }) => {
      const source = sourceArtifactFromManifest(manifest);
      return source ? [source] : [];
    });
    if (
      new Set(
        remoteSourceDescriptors.map(
          ({ documentType, mimeType, sha256, size }) =>
            `${documentType}:${mimeType}:${sha256}:${size}`,
        ),
      ).size > 1
    ) {
      throw new PaperSourcePdfConflictError(summary.documentId);
    }
    const remoteRenderedPrintPdf = selectRenderedPrintPdfDescriptor(resolved.heads);
    const [loadedGenerations, source, renderedPrintPdf] = await Promise.all([
      this.loadCurrentHeadPayloads(
        resolved.generations,
        summary.documentId,
        signal,
        operationCache,
      ),
      this.downloadSnapshotSource(
        remoteSourceDescriptors[0],
        folder.id,
        summary.documentId,
        localState,
        hasReusableStoredSource,
        signal,
        onProgress,
        operationCache,
      ),
      this.downloadSnapshotRenderedPrintPdf(
        remoteRenderedPrintPdf,
        folder.id,
        summary.documentId,
        signal,
        onProgress,
      ),
    ]);
    resolved = {
      ...resolved,
      generations: loadedGenerations,
      heads: derivePaperHeads(loadedGenerations, summary.documentId),
    };
    const folded = foldLoadedHeads(resolved.heads);
    const sourceArtifactDriveEvidence = await this.assertDownloadSnapshotCurrent(
      controlFolderId,
      presence,
      resolved,
      selectedHeadIds,
      remoteSourceDescriptors[0],
      remoteRenderedPrintPdf,
      signal,
      operationCache,
    );
    const cloud = await this.summaryForResolved(resolved, undefined);
    return {
      documentId: summary.documentId,
      displayName: cloud.displayName,
      snapshot: folded.snapshot,
      ...(source.sourceArtifact ? { sourceArtifact: source.sourceArtifact } : {}),
      ...(source.sourceArtifact?.documentType === 'pdf'
        ? { sourcePdf: source.sourceArtifact }
        : {}),
      ...(renderedPrintPdf ? { renderedPrintPdf } : {}),
      ...(source.reusedSourceArtifactFingerprint
        ? {
            reusedSourceArtifactFingerprint: source.reusedSourceArtifactFingerprint,
            ...(remoteSourceDescriptors[0]?.documentType === 'pdf'
              ? {
                  reusedSourcePdfFingerprint: source.reusedSourceArtifactFingerprint,
                }
              : {}),
          }
        : {}),
      ...(sourceArtifactDriveEvidence
        ? {
            sourceArtifactDriveEvidence,
            ...(remoteSourceDescriptors[0]?.documentType === 'pdf'
              ? { sourcePdfDriveEvidence: sourceArtifactDriveEvidence }
              : {}),
          }
        : {}),
      headIds: cloud.headIds,
      conflicts: folded.conflicts,
      cloud,
    };
  }

  private async downloadSnapshotRenderedPrintPdf(
    descriptor: RenderedPrintPdfDescriptor | undefined,
    paperFolderId: string,
    documentId: string,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<StoredRenderedPrintPdf | undefined> {
    if (!descriptor) return undefined;
    const metadataBefore = await this.drive.getMetadata(descriptor.fileId, signal, {
      phase: 'rendered-print-pdf-transfer',
      resource: 'rendered-print-pdf',
      documentId,
    });
    assertRenderedPrintPdfMetadata(
      metadataBefore,
      descriptor,
      paperFolderId,
      documentId,
    );
    onProgress?.({
      documentId,
      phase: 'downloading',
      completed: 0,
      total: 1,
      bytesCompleted: 0,
      bytesTotal: descriptor.size,
      detail: descriptor.fileName,
    });
    const blob = await this.mediaGate.run(() =>
      this.drive.downloadBlob(descriptor.fileId, signal, {
        phase: 'rendered-print-pdf-transfer',
        resource: 'rendered-print-pdf',
        documentId,
      }),
    );
    await assertValidPrintPdfBlob(blob);
    const sha256 = await this.drive.measureOperationPhase(
      'sha-verification',
      () => sha256Hex(blob),
      { documentId, bytesProcessed: blob.size },
    );
    if (blob.size !== descriptor.size || sha256 !== descriptor.sha256) {
      throw new PaperManifestIntegrityError(
        'The selected Print PDF failed integrity verification.',
        documentId,
      );
    }
    onProgress?.({
      documentId,
      phase: 'downloading',
      completed: 1,
      total: 1,
      bytesCompleted: descriptor.size,
      bytesTotal: descriptor.size,
      detail: descriptor.fileName,
    });
    return {
      ...descriptor,
      blob:
        blob.type === 'application/pdf'
          ? blob
          : new Blob([blob], { type: 'application/pdf' }),
      storedAt: this.now(),
    };
  }

  private async downloadSnapshotSource(
    descriptor: ExactPaperSourceArtifact | undefined,
    paperFolderId: string,
    documentId: string,
    localState: PaperSyncState | undefined,
    hasReusableStoredSource: boolean,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
    operationCache?: PaperDownloadOperationCache,
  ): Promise<{
    sourceArtifact?: StoredDocumentSource;
    reusedSourceArtifactFingerprint?: NonNullable<
      PaperSyncState['pdfFingerprints']['source']
    >;
    evidence?: PaperDriveFileEvidence;
  }> {
    if (!descriptor) return {};
    const sourceDescriptor = descriptor;
    const verifiedSourceKey = sourceArtifactCacheKey(sourceDescriptor, paperFolderId);
    const operationCachedSource =
      operationCache?.verifiedSources.get(verifiedSourceKey);
    if (operationCachedSource) {
      onProgress?.({
        documentId,
        phase: 'downloading',
        completed: 1,
        total: 1,
        detail: sourceDescriptor.fileName,
      });
      return { sourceArtifact: operationCachedSource };
    }
    const reusableFingerprint =
      localState?.sourceFingerprints?.source ??
      (descriptor.documentType === 'pdf'
        ? localState?.pdfFingerprints.source
        : undefined);
    const reusableCandidate = Boolean(
      localState &&
      localState.availability !== 'cloud-only' &&
      hasReusableStoredSource &&
      reusableFingerprint &&
      reusableFingerprint.sha256 === descriptor.sha256 &&
      reusableFingerprint.size === descriptor.size,
    );
    const metadataContext = {
      phase: 'source-document-verification',
      resource: 'source-document' as const,
      documentId,
    };
    let metadataBefore: DriveFileMetadata | undefined;
    let blob: Blob | undefined;
    if (reusableCandidate) {
      metadataBefore = await this.drive.getMetadata(
        sourceDescriptor.fileId,
        signal,
        metadataContext,
      );
      assertSourceArtifactMetadata(
        metadataBefore,
        sourceDescriptor,
        paperFolderId,
        documentId,
      );
      const evidence = paperDriveFileEvidence(metadataBefore);
      if (
        reusableFingerprint &&
        evidence &&
        samePaperDriveFileEvidence(
          localState?.driveFiles.sourceArtifactEvidence ??
            (descriptor.documentType === 'pdf'
              ? localState?.driveFiles.sourcePdfEvidence
              : undefined),
          evidence,
        )
      ) {
        return { reusedSourceArtifactFingerprint: reusableFingerprint, evidence };
      }
      blob = await this.mediaGate.run(() =>
        this.drive.downloadBlob(sourceDescriptor.fileId, signal, {
          phase: 'source-document-transfer',
          resource: 'source-document',
          documentId,
        }),
      );
    } else {
      blob = await this.mediaGate.run(() =>
        this.drive.downloadBlob(sourceDescriptor.fileId, signal, {
          phase: 'source-document-transfer',
          resource: 'source-document',
          documentId,
        }),
      );
    }
    onProgress?.({
      documentId,
      phase: 'downloading',
      completed: 0,
      total: 1,
      detail: sourceDescriptor.fileName,
    });
    if (!blob) {
      throw new PaperManifestIntegrityError(
        'The selected paper source document could not be read.',
        documentId,
      );
    }
    const sourceHash = await this.drive.measureOperationPhase(
      'sha-verification',
      () => sha256Hex(blob),
      { documentId, bytesProcessed: blob.size },
    );
    if (blob.size !== sourceDescriptor.size || sourceHash !== sourceDescriptor.sha256) {
      throw new PaperManifestIntegrityError(
        'The selected paper source document failed integrity verification.',
        documentId,
      );
    }
    onProgress?.({
      documentId,
      phase: 'downloading',
      completed: 1,
      total: 1,
    });
    const sourceArtifact = storedSourceFromDescriptor(sourceDescriptor, blob);
    operationCache?.verifiedSources.set(verifiedSourceKey, sourceArtifact);
    return {
      sourceArtifact,
      ...(metadataBefore && paperDriveFileEvidence(metadataBefore)
        ? { evidence: paperDriveFileEvidence(metadataBefore) }
        : {}),
    };
  }

  private async assertDownloadSnapshotCurrent(
    controlFolderId: string,
    selectedPresence: ResolvedPaperPresence,
    selected: ResolvedPaper,
    selectedHeadIds: readonly string[],
    sourceDescriptor: ExactPaperSourceArtifact | undefined,
    renderedPrintPdfDescriptor: RenderedPrintPdfDescriptor | undefined,
    signal: AbortSignal,
    operationCache?: PaperDownloadOperationCache,
  ): Promise<PaperDriveFileEvidence | undefined> {
    const exactSourceDescriptor = sourceDescriptor;
    const sourceCacheKey = exactSourceDescriptor
      ? sourceArtifactCacheKey(exactSourceDescriptor, selected.folder.id)
      : undefined;
    const sourceMetadata = exactSourceDescriptor
      ? this.drive.getMetadata(exactSourceDescriptor.fileId, signal, {
          phase: 'download-commit-guard',
          resource: 'source-document',
          documentId: selectedPresence.documentId,
        })
      : Promise.resolve(undefined);
    const renderedPrintPdfMetadata = renderedPrintPdfDescriptor
      ? this.drive.getMetadata(renderedPrintPdfDescriptor.fileId, signal, {
          phase: 'download-commit-guard',
          resource: 'rendered-print-pdf',
          documentId: selectedPresence.documentId,
        })
      : Promise.resolve(undefined);
    const [
      root,
      control,
      presence,
      folder,
      dataFolder,
      generations,
      source,
      renderedPrintPdf,
    ] = await Promise.all([
      this.requireActiveV3Root(signal, false, {
        phase: 'download-commit-guard',
        dependencyPhase: 'commit-guard',
        documentId: selectedPresence.documentId,
      }),
      this.presence
        .verifyCurrentControlFolder(
          controlFolderId,
          signal,
          selectedPresence.documentId,
        )
        .catch((error: unknown) => {
          if (isDriveOperationFailure(error)) throw error;
          throw new PaperRemoteChangedError(
            selectedPresence.documentId,
            'root-control-changed',
          );
        }),
      this.presence.resolveDocument(
        controlFolderId,
        selectedPresence.documentId,
        signal,
        { controlValidated: true },
      ),
      this.drive.getMetadata(selected.folder.id, signal, {
        phase: 'download-commit-guard',
        resource: 'paper-folder',
        documentId: selectedPresence.documentId,
      }),
      this.drive.getMetadata(selected.dataFolder.id, signal, {
        phase: 'download-commit-guard',
        resource: 'data-folder',
        documentId: selectedPresence.documentId,
      }),
      this.loadManifestGenerations(
        selectedPresence.documentId,
        selected.folder,
        selected.dataFolder,
        signal,
        false,
        true,
      ),
      sourceMetadata,
      renderedPrintPdfMetadata,
    ]);
    if (!presence || presence.state === 'removed') {
      throw new PaperRemovedFromDriveError(selectedPresence.documentId);
    }
    const currentHeadIds = derivePaperHeads(generations, selectedPresence.documentId)
      .map(({ manifest }) => manifest.generation.id)
      .sort(compareCanonicalStrings);
    let sourceEvidence: PaperDriveFileEvidence | undefined;
    if (exactSourceDescriptor && !source) {
      throw new PaperManifestIntegrityError(
        'The selected paper source document metadata is unavailable.',
        selectedPresence.documentId,
      );
    }
    if (exactSourceDescriptor && source) {
      assertSourceArtifactMetadata(
        source,
        exactSourceDescriptor,
        selected.folder.id,
        selectedPresence.documentId,
      );
      sourceEvidence = paperDriveFileEvidence(source);
      const priorEvidence = sourceCacheKey
        ? operationCache?.verifiedSourceEvidence.get(sourceCacheKey)
        : undefined;
      if (
        priorEvidence &&
        sourceEvidence &&
        !samePaperDriveFileEvidence(priorEvidence, sourceEvidence)
      ) {
        throw new PaperRemoteChangedError(
          selectedPresence.documentId,
          'source-snapshot-changed',
        );
      }
      if (sourceCacheKey && sourceEvidence) {
        operationCache?.verifiedSourceEvidence.set(sourceCacheKey, sourceEvidence);
      }
    }
    if (renderedPrintPdfDescriptor && !renderedPrintPdf) {
      throw new PaperManifestIntegrityError(
        'The selected Print PDF metadata is unavailable.',
        selectedPresence.documentId,
      );
    }
    if (renderedPrintPdfDescriptor && renderedPrintPdf) {
      assertRenderedPrintPdfMetadata(
        renderedPrintPdf,
        renderedPrintPdfDescriptor,
        selected.folder.id,
        selectedPresence.documentId,
      );
    }
    if (
      root.appProperties!.controlFolderId !== controlFolderId ||
      control.id !== controlFolderId
    ) {
      throw new PaperRemoteChangedError(
        selectedPresence.documentId,
        'root-control-changed',
      );
    }
    if (
      !sameStringSet(presence.headIds, selectedPresence.headIds) ||
      presence.paperFolderId !== selected.folder.id
    ) {
      throw new PaperRemoteChangedError(
        selectedPresence.documentId,
        'presence-snapshot-changed',
      );
    }
    if (
      !isPaperFolder(folder, this.rootFolderId, selectedPresence.documentId) ||
      !isPaperDataFolder(dataFolder, folder.id, selectedPresence.documentId)
    ) {
      throw new PaperRemoteChangedError(
        selectedPresence.documentId,
        'folder-snapshot-changed',
      );
    }
    if (!sameStringSet(currentHeadIds, selectedHeadIds)) {
      throw new PaperRemoteChangedError(
        selectedPresence.documentId,
        'manifest-head-changed',
      );
    }
    return sourceEvidence;
  }

  downloadSelected(
    summaries: readonly PaperCloudSummary[],
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<PaperDownloadResult[]> {
    return mapWithConcurrency(summaries, PAPER_TRANSFER_CONCURRENCY, (summary) =>
      this.downloadPaper(summary, signal, onProgress),
    );
  }

  async publishPaper(
    local: LocalPaperPackage,
    state: PaperSyncState,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
    options: Pick<PaperDiscoveryOptions, 'layoutValidated'> = {},
  ): Promise<PaperPublishResult> {
    await this.assertValidPaperInput(local, state);
    if (!options.layoutValidated) await this.ensureUsableLayout(signal);
    const root = await this.requireActiveV3Root(signal, true, {
      phase: 'paper-publication-root-validation',
      dependencyPhase: 'root-layout-guard',
      documentId: local.documentId,
    });
    const controlFolderId = root.appProperties!.controlFolderId;
    const initialPresence = await this.presence.resolveDocument(
      controlFolderId,
      local.documentId,
      signal,
      { controlValidated: true },
    );
    if (initialPresence?.state === 'removed') {
      throw new PaperRemovedFromDriveError(local.documentId);
    }
    const expectedPresenceHeads = initialPresence?.headIds ?? [];
    const authorizePublication = async () => {
      const [currentRoot, current] = await Promise.all([
        this.requireActiveV3Root(signal, false, {
          phase: 'paper-publication-commit-guard',
          dependencyPhase: 'commit-guard',
          documentId: local.documentId,
        }),
        this.presence.resolveDocument(controlFolderId, local.documentId, signal, {
          controlValidated: true,
        }),
      ]);
      if (currentRoot.appProperties!.controlFolderId !== controlFolderId) {
        throw new PaperRepositoryError(
          'paper-presence-invalid',
          'The Drive control area changed before publication.',
        );
      }
      if (
        !sameStringSet(current?.headIds ?? [], expectedPresenceHeads) ||
        current?.state === 'removed'
      ) {
        throw new PaperRemovedFromDriveError(local.documentId);
      }
    };
    const result = await this.publishPaperAfterLayoutAuthorization(
      local,
      state,
      signal,
      onProgress,
      authorizePublication,
      initialPresence?.paperFolderId
        ? { requiredPaperFolderId: initialPresence.paperFolderId }
        : undefined,
    );
    const presence =
      initialPresence ??
      (await this.presence.publishInitialUpload(
        controlFolderId,
        {
          documentId: local.documentId,
          displayName: result.displayName,
          paperFolderId: result.cloud.paperFolderId,
          writer: local.writer,
        },
        signal,
        null,
        () => this.assertControlRootGuard(controlFolderId, local.documentId, signal),
      ));
    return withPresence(result, presence);
  }

  async restorePaper(
    local: LocalPaperPackage,
    state: PaperSyncState,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<PaperRestoreResult> {
    this.drive.recordOperationStateTransition({
      phase: 'paper-restore',
      transition: 'repository-restore-started',
      documentId: local.documentId,
      outcome: 'started',
    });
    await this.assertValidPaperInput(local, state);
    const root = await this.requireActiveV3Root(signal, true, {
      phase: 'paper-restore-root-validation',
      dependencyPhase: 'root-layout-guard',
      documentId: local.documentId,
    });
    const controlFolderId = root.appProperties!.controlFolderId;
    const removed = await this.presence.resolveDocument(
      controlFolderId,
      local.documentId,
      signal,
      { controlValidated: true },
    );
    if (!removed || removed.state !== 'removed') {
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'Explicit restore requires an authoritative removed presence state.',
      );
    }
    this.drive.recordOperationStateTransition({
      phase: 'paper-restore-presence-resolution',
      transition: 'presence-resolved',
      documentId: local.documentId,
      presenceState: 'removed',
      outcome: 'succeeded',
    });
    const expectedRemovedHeads = [...removed.headIds];
    const expectedPaperFolderId = removed.paperFolderId;
    if (!expectedPaperFolderId || !isSafeDriveId(expectedPaperFolderId)) {
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'The removed paper does not retain an exact prior Drive folder identity.',
      );
    }
    const authorizeRestorePackage = async () => {
      const [currentRoot, current] = await Promise.all([
        this.requireActiveV3Root(signal, false, {
          phase: 'paper-restore-commit-guard',
          dependencyPhase: 'commit-guard',
          documentId: local.documentId,
        }),
        this.presence.resolveDocument(controlFolderId, local.documentId, signal, {
          controlValidated: true,
        }),
      ]);
      if (
        currentRoot.appProperties!.controlFolderId !== controlFolderId ||
        !current ||
        current.state !== 'removed' ||
        current.paperFolderId !== expectedPaperFolderId ||
        !sameStringSet(current.headIds, expectedRemovedHeads)
      ) {
        throw new PaperRemoteChangedError(local.documentId);
      }
    };

    const priorFolderRequest = this.drive
      .getMetadata(expectedPaperFolderId, signal, {
        phase: 'paper-restore-preflight',
        resource: 'paper-folder',
        documentId: local.documentId,
      })
      .catch((error: unknown) => {
        if (isInaccessibleDriveIdentity(error)) return undefined;
        throw error;
      });
    const [activeFolders, priorFolder] = await Promise.all([
      this.listPaperFolders(signal, local.documentId),
      priorFolderRequest,
    ]);
    this.drive.recordOperationStateTransition({
      phase: 'paper-restore-folder-resolution',
      transition: 'paper-folder-selected',
      documentId: local.documentId,
      folderIdentity: !priorFolder
        ? 'missing'
        : priorFolder.id !== expectedPaperFolderId
          ? 'mismatch'
          : priorFolder.trashed
            ? 'selected-trashed'
            : 'selected-active',
      outcome: priorFolder ? 'succeeded' : 'failed',
    });
    const conflictingActiveFolders = activeFolders.filter(
      ({ id }) => id !== expectedPaperFolderId,
    );
    if (conflictingActiveFolders.length > 0 || activeFolders.length > 1) {
      throw new AmbiguousManagedPaperError(
        local.documentId,
        activeFolders.map(({ id }) => id),
      );
    }

    let result: PaperPublishResult | undefined;
    let restoreMode: PaperRestoreResult['restoreMode'] = 'fallback-rebuild';
    if (
      priorFolder &&
      isOwnedPaperFolderIdentity(priorFolder, this.rootFolderId, local.documentId)
    ) {
      let reusable:
        | {
            folder: DriveFileMetadata;
            resolved: ResolvedPaper;
            source: NonNullable<PaperPublicationOptions['knownSource']>;
          }
        | undefined;
      let folderMayBeActive = isPaperFolder(
        priorFolder,
        this.rootFolderId,
        local.documentId,
      );
      try {
        let restoredFolder = priorFolder;
        if (!folderMayBeActive) {
          restoredFolder = await this.drive.restoreManagedPaperFolder(
            restoredFolder.id,
            this.rootFolderId,
            restoredFolder.parents ?? [],
            signal,
            {
              phase: 'paper-restore-untrash',
              resource: 'paper-folder',
              documentId: local.documentId,
            },
          );
          folderMayBeActive = true;
          this.drive.recordOperationStateTransition({
            phase: 'paper-restore-untrash',
            transition: 'paper-folder-untrashed',
            documentId: local.documentId,
            folderIdentity: 'selected-active',
            outcome: 'succeeded',
          });
        }
        const verifiedFolder = restoredFolder;
        if (
          restoredFolder.id !== expectedPaperFolderId ||
          !isPaperFolder(restoredFolder, this.rootFolderId, local.documentId) ||
          restoredFolder.ownedByMe !== true ||
          !isPaperFolder(verifiedFolder, this.rootFolderId, local.documentId) ||
          verifiedFolder.ownedByMe !== true
        ) {
          throw new PaperManifestIntegrityError(
            'Google Drive did not restore the exact managed paper folder.',
            local.documentId,
          );
        }
        const manifestResolved = await this.resolvePaperFolder(
          verifiedFolder,
          signal,
          false,
          undefined,
          true,
        );
        const [generations, source] = await Promise.all([
          this.loadCurrentHeadPayloads(
            manifestResolved.generations,
            local.documentId,
            signal,
          ),
          this.verifyRestoredPackageSource(local, state, manifestResolved, signal),
        ]);
        const resolved = {
          ...manifestResolved,
          generations,
          heads: derivePaperHeads(generations, local.documentId),
        };
        foldLoadedHeads(resolved.heads);
        this.drive.recordOperationStateTransition({
          phase: 'paper-restore-package-verification',
          transition: 'paper-package-verified',
          documentId: local.documentId,
          outcome: 'succeeded',
        });
        reusable = { folder: verifiedFolder, resolved, source };
      } catch (error) {
        const fallbackAllowed = shouldFallbackAfterRestoreVerification(error);
        const mustReturnToTrash =
          fallbackAllowed || error instanceof PaperSourcePdfConflictError;
        if (folderMayBeActive && mustReturnToTrash) {
          const reTrashed = await this.drive.trashManagedPaperFolder(
            expectedPaperFolderId,
            signal,
            {
              phase: 'paper-restore-fallback-cleanup',
              resource: 'paper-folder',
              documentId: local.documentId,
            },
          );
          if (reTrashed.id !== expectedPaperFolderId || reTrashed.trashed !== true) {
            throw new PaperManifestIntegrityError(
              'The unusable prior paper folder could not be returned to Drive Trash.',
              local.documentId,
              error,
            );
          }
        }
        if (!fallbackAllowed) throw error;
      }
      if (reusable) {
        state.driveFiles.paperFolderId = reusable.folder.id;
        state.driveFiles.dataFolderId = reusable.resolved.dataFolder.id;
        result = await this.publishPaperAfterLayoutAuthorization(
          local,
          state,
          signal,
          onProgress,
          authorizeRestorePackage,
          {
            knownFolder: reusable.folder,
            knownDataFolder: reusable.resolved.dataFolder,
            knownResolved: reusable.resolved,
            knownSource: reusable.source,
            skipNoOpAuthorization: true,
          },
        );
        restoreMode = 'fast-untrash';
      }
    }

    if (!result) {
      delete state.driveFiles.paperFolderId;
      delete state.driveFiles.dataFolderId;
      delete state.driveFiles.sourcePdfFileId;
      delete state.driveFiles.sourcePdfEvidence;
      delete state.driveFiles.sourceArtifactFileId;
      delete state.driveFiles.sourceArtifactEvidence;
      onProgress?.({
        documentId: local.documentId,
        phase: 'resolving',
        detail: 'Original Drive folder unavailable; rebuilding safely',
      });
      try {
        result = await this.publishPaperAfterLayoutAuthorization(
          local,
          state,
          signal,
          onProgress,
          authorizeRestorePackage,
        );
      } catch (error) {
        const fallbackFolderId = state.driveFiles.paperFolderId;
        if (fallbackFolderId && fallbackFolderId !== expectedPaperFolderId) {
          try {
            const fallbackFolder = await this.drive.getMetadata(
              fallbackFolderId,
              signal,
              {
                phase: 'paper-restore-fallback-cleanup',
                resource: 'paper-folder',
                documentId: local.documentId,
              },
            );
            if (
              isPaperFolder(fallbackFolder, this.rootFolderId, local.documentId) &&
              fallbackFolder.ownedByMe === true
            ) {
              await this.drive.trashManagedPaperFolder(fallbackFolder.id, signal, {
                phase: 'paper-restore-fallback-cleanup',
                resource: 'paper-folder',
                documentId: local.documentId,
              });
            }
          } catch {
            // Presence remains removed. A later scoped audit can expose cleanup
            // without ever treating this partial package as active authority.
          }
        }
        throw error;
      }
    }
    const restored = await this.presence.publishRestore(
      controlFolderId,
      {
        documentId: local.documentId,
        displayName: result.displayName,
        paperFolderId: result.cloud.paperFolderId,
        writer: local.writer,
        expectedRemovedHeadIds: expectedRemovedHeads,
        expectedRemovedPaperFolderId: expectedPaperFolderId,
      },
      signal,
      () => this.assertControlRootGuard(controlFolderId, local.documentId, signal),
    );
    this.drive.recordOperationStateTransition({
      phase: 'paper-restore-presence-publication',
      transition: 'present-presence-published',
      documentId: local.documentId,
      presenceState: restored.state,
      outcome: 'succeeded',
    });
    return { ...withPresence(result, restored), restoreMode };
  }

  async reconcileKeepLocalPaper(
    local: LocalPaperPackage,
    state: PaperSyncState,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<PaperPublishResult> {
    await this.assertValidPaperInput(local, state);
    const root = await this.requireActiveV3Root(signal, true, {
      phase: 'keep-local-root-validation',
      dependencyPhase: 'root-layout-guard',
      documentId: local.documentId,
    });
    const controlFolderId = root.appProperties!.controlFolderId;
    const initialPresence = await this.presence.resolveDocument(
      controlFolderId,
      local.documentId,
      signal,
      { controlValidated: true },
    );
    if (
      !initialPresence ||
      initialPresence.state !== 'present' ||
      !initialPresence.paperFolderId
    ) {
      throw new PaperRemovedFromDriveError(local.documentId);
    }
    const expectedPresenceHeads = [...initialPresence.headIds];
    const expectedPaperFolderId = initialPresence.paperFolderId;
    let authorizedPresence: ResolvedPaperPresence | undefined;
    const authorizeReconciliation = async () => {
      const [currentRoot, current] = await Promise.all([
        this.requireActiveV3Root(signal, false, {
          phase: 'keep-local-commit-guard',
          dependencyPhase: 'commit-guard',
          documentId: local.documentId,
        }),
        this.presence.resolveDocument(controlFolderId, local.documentId, signal, {
          controlValidated: true,
        }),
      ]);
      if (
        currentRoot.appProperties!.controlFolderId !== controlFolderId ||
        !current ||
        current.state !== 'present' ||
        current.paperFolderId !== expectedPaperFolderId ||
        !sameStringSet(current.headIds, expectedPresenceHeads)
      ) {
        throw new PaperRemoteChangedError(local.documentId);
      }
      authorizedPresence = current;
    };
    state.driveFiles.paperFolderId = expectedPaperFolderId;
    const [knownFolder, knownDataFolder] = await Promise.all([
      this.drive.getMetadata(expectedPaperFolderId, signal, {
        phase: 'paper-folder-resolution',
        resource: 'paper-folder',
        documentId: local.documentId,
      }),
      this.findSingleDataFolder(
        { id: expectedPaperFolderId },
        local.documentId,
        signal,
      ),
    ]);
    if (!isPaperFolder(knownFolder, this.rootFolderId, local.documentId)) {
      throw new PaperRemoteChangedError(local.documentId);
    }
    state.driveFiles.dataFolderId = knownDataFolder.id;
    const manifestResolved = await this.resolvePaperFolder(
      knownFolder,
      signal,
      false,
      knownDataFolder,
      true,
    );
    const [generations, knownSource] = await Promise.all([
      this.loadCurrentHeadPayloads(
        manifestResolved.generations,
        local.documentId,
        signal,
      ),
      this.verifyRestoredPackageSource(local, state, manifestResolved, signal),
    ]);
    const knownResolved = {
      ...manifestResolved,
      generations,
      heads: derivePaperHeads(generations, local.documentId),
    };
    const result = await this.publishPaperAfterLayoutAuthorization(
      local,
      state,
      signal,
      onProgress,
      authorizeReconciliation,
      {
        reconciliation: 'keep-local',
        forceGeneration: true,
        requiredPaperFolderId: expectedPaperFolderId,
        knownFolder,
        knownDataFolder,
        knownResolved,
        knownSource,
      },
    );
    if (!authorizedPresence) {
      throw new PaperRemoteChangedError(local.documentId);
    }
    return withPresence(result, authorizedPresence);
  }

  async removePaperFromDrive(
    summary: PaperCloudSummary,
    writer: PaperPresenceWriter,
    signal: AbortSignal,
  ): Promise<PaperCloudRemovalResult> {
    this.drive.recordOperationStateTransition({
      phase: 'paper-removal',
      transition: 'repository-remove-started',
      documentId: summary.documentId,
      outcome: 'started',
    });
    const root = await this.requireActiveV3Root(signal, true, {
      phase: 'paper-removal-root-validation',
      dependencyPhase: 'root-layout-guard',
      documentId: summary.documentId,
    });
    const controlFolderId = root.appProperties!.controlFolderId;
    const targetMetadata = this.drive
      .getMetadata(summary.paperFolderId, signal, {
        phase: 'paper-removal-preflight',
        resource: 'paper-folder',
        documentId: summary.documentId,
      })
      .catch((error: unknown) => {
        if (error instanceof DriveRequestError && error.status === 404)
          return undefined;
        throw error;
      });
    const [current, target] = await Promise.all([
      this.presence.resolveDocument(controlFolderId, summary.documentId, signal, {
        controlValidated: true,
      }),
      targetMetadata,
    ]);
    if (!current) {
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'The paper has no authoritative presence state.',
      );
    }
    this.drive.recordOperationStateTransition({
      phase: 'paper-removal-presence-resolution',
      transition: 'presence-resolved',
      documentId: summary.documentId,
      presenceState: current.state,
      outcome: 'succeeded',
    });
    const targetId = current.paperFolderId;
    if (!targetId || targetId !== summary.paperFolderId) {
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'The exact active paper folder could not be proven.',
      );
    }
    if (
      target &&
      (!isOwnedPaperFolderIdentity(target, this.rootFolderId, summary.documentId) ||
        (current.state === 'present' &&
          !isPaperFolder(target, this.rootFolderId, summary.documentId)) ||
        target.ownedByMe !== true ||
        target.appProperties?.role === PAPER_V3_CONTROL_ROLE)
    ) {
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'The Drive removal target is not the exact app-owned paper folder.',
      );
    }
    this.drive.recordOperationStateTransition({
      phase: 'paper-removal-folder-resolution',
      transition: 'paper-folder-selected',
      documentId: summary.documentId,
      folderIdentity: !target
        ? 'missing'
        : target.trashed
          ? 'selected-trashed'
          : 'selected-active',
      outcome: target ? 'succeeded' : 'failed',
    });
    const alreadyRemoved = current.state === 'removed';
    const removed = alreadyRemoved
      ? current
      : await this.presence.publishRemoved(
          controlFolderId,
          {
            documentId: summary.documentId,
            displayName: summary.displayName,
            paperFolderId: targetId,
            writer,
          },
          signal,
          current,
          () =>
            this.assertControlRootGuard(controlFolderId, summary.documentId, signal),
        );
    if (!alreadyRemoved) {
      this.drive.recordOperationStateTransition({
        phase: 'paper-removal-presence-publication',
        transition: 'removed-presence-published',
        documentId: summary.documentId,
        presenceState: removed.state,
        outcome: 'succeeded',
      });
    }

    let cleanupPending = Boolean(target && !target.trashed);
    let cleanupError: string | undefined;
    if (cleanupPending && target) {
      try {
        const trashed = await this.drive.trashManagedPaperFolder(target.id, signal, {
          phase: 'paper-removal-cleanup',
          resource: 'paper-folder',
          documentId: summary.documentId,
        });
        cleanupPending = trashed.id !== target.id || trashed.trashed !== true;
        if (!cleanupPending) {
          this.drive.recordOperationStateTransition({
            phase: 'paper-removal-cleanup',
            transition: 'paper-folder-trashed',
            documentId: summary.documentId,
            folderIdentity: 'selected-trashed',
            outcome: 'succeeded',
          });
        }
        if (cleanupPending) {
          cleanupError =
            'Google Drive did not confirm that the paper folder was moved to Trash.';
        }
      } catch (error) {
        cleanupPending = true;
        cleanupError =
          error instanceof Error
            ? error.message
            : 'The Drive folder cleanup did not finish.';
      }
    }
    if (cleanupPending) {
      this.drive.recordOperationStateTransition({
        phase: 'paper-removal-cleanup',
        transition: 'cleanup-deferred',
        documentId: summary.documentId,
        folderIdentity: target?.trashed ? 'selected-trashed' : 'selected-active',
        outcome: 'deferred',
      });
    }
    const cloud = await removedPaperSummary(
      removed,
      undefined,
      cleanupPending && target ? [target] : [],
      false,
    );
    return {
      cloud: { ...cloud, displayName: summary.displayName, cleanupPending },
      cleanupPending,
      ...(cleanupError ? { cleanupError } : {}),
    };
  }

  async prepareV3Migration(
    states: readonly PaperSyncState[] | undefined,
    signal: AbortSignal,
  ): Promise<PaperV3MigrationPreparation> {
    const papers = await this.discoverV2ForMigration(states, signal);
    const failed = papers.find((paper) => paper.issue);
    if (failed) {
      throw new PaperLayoutMigrationProofError(
        `Paper ${failed.documentId} could not be verified for the v3 migration.`,
      );
    }
    const control = await this.presence.createOrVerifyControlFolder(signal);
    return { controlFolderId: control.id, papers };
  }

  async seedV3MigrationPresence(
    controlFolderId: string,
    paper: PaperCloudSummary,
    writer: PaperPresenceWriter,
    signal: AbortSignal,
  ): Promise<PaperV3MigrationSeed> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'v3-migration-presence',
      resource: 'root',
    });
    if (!isPaperV2RootMetadata(root)) {
      throw new PaperLayoutMigrationProofError(
        'The root changed before the v3 presence baseline was complete.',
      );
    }
    const folder = await this.drive.getMetadata(paper.paperFolderId, signal);
    if (!isPaperFolder(folder, this.rootFolderId, paper.documentId)) {
      throw new PaperLayoutMigrationProofError(
        'A migration paper folder changed before presence publication.',
      );
    }
    const resolved = await this.resolvePaperFolder(folder, signal, false);
    const currentSummary = await this.summaryForResolved(resolved, undefined);
    if (!sameStringSet(currentSummary.headIds, paper.headIds)) {
      throw new PaperRemoteChangedError(paper.documentId);
    }
    const presence = await this.presence.publishMigrationBaseline(
      controlFolderId,
      {
        documentId: paper.documentId,
        displayName: paper.displayName,
        paperFolderId: paper.paperFolderId,
        state: paper.deleted ? 'removed' : 'present',
        writer,
      },
      signal,
    );
    return {
      documentId: paper.documentId,
      generationId: presence.headIds[0],
      paperFolderId: paper.paperFolderId,
      state: presence.state,
      packageHeadIds: [...paper.headIds].sort(compareCanonicalStrings),
    };
  }

  async activateV3Migration(
    controlFolderId: string,
    seeds: readonly PaperV3MigrationSeed[],
    writer: PaperPresenceWriter,
    signal: AbortSignal,
  ): Promise<PaperV3MigrationCompletion> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'v3-migration-activation',
      resource: 'root',
    });
    if (!isPaperV2RootMetadata(root) && !isPaperV3RootMetadata(root)) {
      throw new PaperLayoutMigrationProofError(
        'The root changed before the v3 migration could activate.',
      );
    }
    if (isPaperV2RootMetadata(root)) {
      const currentPapers = await this.discoverV2ForMigration(undefined, signal);
      const currentById = new Map(
        currentPapers.map((paper) => [paper.documentId, paper] as const),
      );
      if (
        currentPapers.some((paper) => paper.issue) ||
        !sameStringSet(
          currentPapers.map((paper) => paper.documentId),
          seeds.map((seed) => seed.documentId),
        ) ||
        seeds.some((seed) => {
          const paper = currentById.get(seed.documentId);
          return (
            !paper ||
            paper.paperFolderId !== seed.paperFolderId ||
            !sameStringSet(paper.headIds, seed.packageHeadIds)
          );
        })
      ) {
        throw new PaperRemoteChangedError('v3-migration');
      }
    }
    const presenceGenerations = Object.fromEntries(
      [...seeds]
        .sort((first, second) =>
          compareCanonicalStrings(first.documentId, second.documentId),
        )
        .map((seed) => [
          seed.documentId,
          {
            generationId: seed.generationId,
            paperFolderId: seed.paperFolderId,
            state: seed.state,
          },
        ]),
    );
    const completion = await this.presence.ensureMigrationCompletion(
      controlFolderId,
      presenceGenerations,
      writer.deviceId,
      signal,
    );
    await this.activateV3RootMetadata(controlFolderId, completion.id, signal, false);
    await this.assertActiveRoot(signal);
    return completion;
  }

  async openLayoutMigration(
    suppliedProof: PaperLayoutMigrationProof,
    signal: AbortSignal,
  ): Promise<PaperLayoutMigrationPublisher> {
    const proof = normalizeMigrationProof(suppliedProof);
    await this.assertLayoutMigrationProof(proof, signal);
    return Object.freeze({
      publishPaper: async (
        local: LocalPaperPackage,
        state: PaperSyncState,
        operationSignal: AbortSignal,
        onProgress?: (progress: PaperTransferProgress) => void,
      ) => {
        if (proof.phase !== 'publishing-papers') {
          throw new PaperLayoutMigrationProofError(
            'Paper publication is not allowed after layout activation has started.',
          );
        }
        await this.assertValidPaperInput(local, state);
        if (!proof.targetDocumentIds.includes(local.documentId)) {
          throw new PaperLayoutMigrationProofError(
            'The paper is not part of the persisted Drive layout migration.',
          );
        }
        await this.assertLayoutMigrationProof(proof, operationSignal);
        return this.publishPaperAfterLayoutAuthorization(
          local,
          state,
          operationSignal,
          onProgress,
        );
      },
      verifyPublishedPapers: (operationSignal: AbortSignal) =>
        this.verifyLayoutMigrationPapers(proof, operationSignal),
      activate: async (operationSignal: AbortSignal) => {
        if (proof.phase !== 'activating-layout') {
          throw new PaperLayoutMigrationProofError(
            'The persisted Drive layout migration is not ready for activation.',
          );
        }
        const inspection = await this.assertLayoutMigrationProof(
          proof,
          operationSignal,
        );
        await this.verifyLayoutMigrationPapers(proof, operationSignal);
        if (inspection.state !== 'paper-v2-upgrade-required') {
          await this.activateRebuiltLayout(proof, operationSignal);
        }
        await this.verifyLayoutActivationMarker(proof, operationSignal);
        const activated = await this.detectLayout(operationSignal);
        if (
          activated.state !== 'paper-v2-upgrade-required' ||
          !sameStringSet(activated.legacyManagedFileIds, proof.verifiedLegacyFileIds)
        ) {
          throw new PaperLayoutMigrationIncompleteError();
        }
      },
    });
  }

  private async assertValidPaperInput(
    local: LocalPaperPackage,
    state: PaperSyncState,
  ): Promise<void> {
    if (state.documentId !== local.documentId) {
      throw new Error('Paper sync state belongs to another paper.');
    }
    assertPaperSnapshot(local.snapshot, local.documentId);
    if (local.deleted !== snapshotIsDeleted(local.snapshot, local.documentId)) {
      throw new Error('The paper deletion marker does not match its snapshot.');
    }
    assertNoSecretsInSyncPayload(local);
    const source = sourceArtifactFromLocalPackage(local);
    if (source) {
      const legacyDescriptor = local.snapshot.pdfs.find(
        (pdf) => pdf.documentId === local.documentId,
      );
      if (
        source.documentId !== local.documentId ||
        source.mimeType !== getDocumentMimeType(source.documentType) ||
        source.blob.size !== source.size ||
        (local.sourcePdf &&
          (!legacyDescriptor ||
            legacyDescriptor.sha256 !== source.sha256 ||
            legacyDescriptor.size !== source.size)) ||
        (!(local.sourceArtifactHashVerified || local.sourcePdfHashVerified) &&
          (await sha256Hex(source.blob)) !== source.sha256)
      ) {
        throw new PaperManifestIntegrityError(
          'The local paper source document failed validation.',
          local.documentId,
        );
      }
    }
    if (local.renderedPrintPdf) {
      const artifact = local.renderedPrintPdf;
      if (
        artifact.documentId !== local.documentId ||
        artifact.kind !== 'rendered-print-pdf' ||
        artifact.mimeType !== 'application/pdf' ||
        artifact.blob.size !== artifact.size ||
        (!(local.renderedPrintPdfHashVerified ?? false) &&
          (await sha256Hex(artifact.blob)) !== artifact.sha256)
      ) {
        throw new PaperManifestIntegrityError(
          'The local Print PDF failed validation.',
          local.documentId,
        );
      }
      try {
        await assertValidPrintPdfBlob(artifact.blob);
      } catch (error) {
        throw new PaperManifestIntegrityError(
          'The local Print PDF failed validation.',
          local.documentId,
          error,
        );
      }
    }
  }

  private async publishPaperAfterLayoutAuthorization(
    local: LocalPaperPackage,
    state: PaperSyncState,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
    authorizeCommit?: () => Promise<void>,
    options: PaperPublicationOptions = {},
  ): Promise<PaperPublishResult> {
    const displayName = normalizePresentationName(local.displayName);
    const folder =
      options.knownFolder ??
      (await this.ensurePaperFolder(
        local.documentId,
        displayName,
        state,
        signal,
        options.requiredPaperFolderId,
      ));
    if (
      (options.requiredPaperFolderId && folder.id !== options.requiredPaperFolderId) ||
      !isPaperFolder(folder, this.rootFolderId, local.documentId)
    ) {
      throw new PaperRemoteChangedError(local.documentId);
    }
    const dataFolder =
      options.knownDataFolder ??
      (await this.ensureDataFolder(local.documentId, folder, state, signal));
    if (!isPaperDataFolder(dataFolder, folder.id, local.documentId)) {
      throw new PaperRemoteChangedError(local.documentId);
    }
    let resolved =
      options.knownResolved ??
      (await this.resolvePaperFolder(folder, signal, true, dataFolder, true));
    if (resolved.folder.id !== folder.id || resolved.dataFolder.id !== dataFolder.id) {
      throw new PaperRemoteChangedError(local.documentId);
    }
    const currentHeadIds = resolved.heads
      .map(({ manifest }) => manifest.generation.id)
      .sort(compareCanonicalStrings);
    const remoteChanged = !sameStringSet(state.incorporatedHeadIds, currentHeadIds);
    onProgress?.({
      documentId: local.documentId,
      phase: 'merging',
      detail: remoteChanged ? 'Reconciling newer Drive changes' : 'Preparing changes',
    });

    const remoteFolded =
      resolved.heads.length > 0 ? foldLoadedHeads(resolved.heads) : null;
    let mergedSnapshot = local.snapshot;
    let conflicts = mergeConflicts(state.conflicts);
    if (remoteFolded) {
      if (options.reconciliation === 'keep-local') {
        // The user explicitly selected the current local editable state. Remote
        // journals remain preserved as immutable ancestry evidence, while the
        // editable snapshot itself is not merged back over that decision.
        conflicts = mergeConflicts(conflicts, remoteFolded.conflicts);
      } else {
        try {
          const merged = mergeSyncSnapshots(
            local.snapshot,
            remoteFolded.snapshot,
            state.baselineHashes,
            deterministicSnapshotTime(local.snapshot, remoteFolded.snapshot),
          );
          mergedSnapshot = merged.snapshot;
          conflicts = mergeConflicts(
            conflicts,
            remoteFolded.conflicts,
            merged.conflicts,
          );
        } catch (error) {
          if (error instanceof Error && /Original PDF conflict/u.test(error.message)) {
            throw new PaperSourcePdfConflictError(local.documentId);
          }
          throw error;
        }
      }
    }
    assertPaperSnapshot(mergedSnapshot, local.documentId);

    const localSource = sourceArtifactFromLocalPackage(local);
    const [source, renderedPrintPdf] = await Promise.all([
      options.knownSource ??
        this.resolveSourceArtifact(
          localSource,
          resolved.heads,
          state.driveFiles.sourceArtifactEvidence ??
            (localSource?.documentType === 'pdf'
              ? state.driveFiles.sourcePdfEvidence
              : undefined),
          folder.id,
          local.documentId,
          signal,
          onProgress,
        ),
      this.resolveRenderedPrintPdf(
        local.renderedPrintPdf,
        resolved.heads,
        !state.dirtyReasons.includes('rendered-print-pdf'),
        folder.id,
        local.documentId,
        signal,
        onProgress,
      ),
    ]);
    if (
      localSource &&
      (!source.descriptor ||
        !sourceArtifactsHaveSameIdentity(localSource, source.descriptor))
    ) {
      throw new PaperSourcePdfConflictError(local.documentId);
    }

    const priorHead = resolved.heads.length === 1 ? resolved.heads[0].manifest : null;
    const noOp =
      !options.forceGeneration &&
      Boolean(priorHead) &&
      resolved.heads.length === 1 &&
      priorHead?.displayName === displayName &&
      snapshotContent(remoteFolded!.snapshot) === snapshotContent(mergedSnapshot) &&
      sameConflictIds(priorHead.conflictIds, conflicts) &&
      sameOptionalRenderedPrintPdf(
        priorHead.renderedPrintPdf,
        renderedPrintPdf.descriptor,
      );
    if (noOp && priorHead) {
      if (!options.skipNoOpAuthorization) await authorizeCommit?.();
      const cloud = await this.summaryForResolved(resolved, state);
      return {
        documentId: local.documentId,
        displayName,
        snapshot: {
          ...remoteFolded!.snapshot,
          pdfs: source.descriptor?.documentType === 'pdf' ? [source.descriptor] : [],
        },
        cloud,
        manifest: priorHead,
        sourcePdfUploaded: false,
        sourceArtifactUploaded: false,
        renderedPrintPdfUploaded: false,
        ...(source.evidence
          ? {
              sourceArtifactDriveEvidence: source.evidence,
              ...(source.descriptor?.documentType === 'pdf'
                ? { sourcePdfDriveEvidence: source.evidence }
                : {}),
            }
          : {}),
        filesUploaded: 0,
        remoteChanged,
        noOp: true,
        conflicts,
      };
    }

    const partitions = partitionPaperSnapshot(mergedSnapshot, local.documentId);
    const [stateEncoded, productivityEncoded, conflictsEncoded] = await Promise.all([
      encodeCloudPayload(partitions.state),
      encodeCloudPayload(partitions.productivity),
      encodePaperConflictPayload(local.documentId, conflicts),
    ]);
    const [stateFile, productivityFile, conflictFile] = await Promise.all([
      this.putPayload(
        'paper-state',
        STATE_NAME,
        stateEncoded,
        priorHead?.state,
        dataFolder.id,
        local.documentId,
        signal,
      ),
      this.putPayload(
        'paper-productivity',
        PRODUCTIVITY_NAME,
        productivityEncoded,
        priorHead?.productivity,
        dataFolder.id,
        local.documentId,
        signal,
      ),
      this.putConflictPayload(
        CONFLICTS_NAME,
        conflictsEncoded,
        priorHead?.conflictJournal,
        dataFolder.id,
        local.documentId,
        signal,
      ),
    ]);
    let filesUploaded =
      Number(stateFile.created) +
      Number(productivityFile.created) +
      Number(conflictFile.created);

    filesUploaded += Number(source.uploaded);
    filesUploaded += Number(renderedPrintPdf.uploaded);

    const base: PaperManifestBase = {
      app: '39Note',
      syncLayoutVersion: PAPER_PACKAGE_LAYOUT_VERSION,
      paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
      payloadStorage: PAPER_PAYLOAD_STORAGE,
      manifestStorage: PAPER_MANIFEST_STORAGE,
      documentId: local.documentId,
      paperFolderId: folder.id,
      dataFolderId: dataFolder.id,
      displayName,
      deleted: snapshotIsDeleted(mergedSnapshot, local.documentId),
      writer: sanitizeWriter(local.writer),
      state: stateFile.reference,
      productivity: productivityFile.reference,
      conflictJournal: conflictFile.reference,
      conflictIds: conflicts
        .map((conflict) => conflict.id)
        .sort(compareCanonicalStrings),
      ...(source.descriptor ? { sourceArtifact: source.descriptor } : {}),
      ...(renderedPrintPdf.descriptor
        ? { renderedPrintPdf: renderedPrintPdf.descriptor }
        : {}),
    };
    const manifest = await createPaperManifestGeneration(base, {
      createdAt: this.now(),
      createdBy: base.writer.deviceId,
      parents: currentHeadIds,
    });
    onProgress?.({
      documentId: local.documentId,
      phase: 'publishing',
      detail: 'Publishing immutable paper generation',
    });
    // Payloads are immutable and harmless if orphaned. Revalidate the root and
    // presence immediately before the authoritative manifest-last commit.
    await authorizeCommit?.();
    const manifestFile = await this.publishManifest(manifest, dataFolder.id, signal);
    filesUploaded += 1;
    onProgress?.({
      documentId: local.documentId,
      phase: 'verifying',
      detail: 'Verifying paper generation',
    });
    resolved = await this.resolvePaperFolder(folder, signal, false, dataFolder, true);
    if (
      resolved.heads.length !== 1 ||
      resolved.heads[0].manifest.generation.id !== manifest.generation.id ||
      resolved.heads[0].file.id !== manifestFile.id
    ) {
      throw new PaperRemoteChangedError(local.documentId);
    }
    const cloud = await this.summaryForResolved(resolved, state);
    return {
      documentId: local.documentId,
      displayName,
      snapshot: {
        ...mergedSnapshot,
        pdfs: source.descriptor?.documentType === 'pdf' ? [source.descriptor] : [],
      },
      cloud,
      manifest,
      sourcePdfUploaded: source.uploaded && source.descriptor?.documentType === 'pdf',
      sourceArtifactUploaded: source.uploaded,
      renderedPrintPdfUploaded: renderedPrintPdf.uploaded,
      ...(source.evidence
        ? {
            sourceArtifactDriveEvidence: source.evidence,
            ...(source.descriptor?.documentType === 'pdf'
              ? { sourcePdfDriveEvidence: source.evidence }
              : {}),
          }
        : {}),
      filesUploaded,
      remoteChanged,
      noOp: false,
      conflicts,
    };
  }

  private async assertLayoutMigrationProof(
    proof: Readonly<PaperLayoutMigrationProof>,
    signal: AbortSignal,
  ): Promise<PaperLayoutInspection> {
    if (proof.rootFolderId !== this.rootFolderId) {
      throw new PaperLayoutMigrationProofError(
        'The persisted migration belongs to a different Drive root.',
      );
    }
    const inspection = await this.detectLayout(signal);
    const allowed =
      inspection.state === 'legacy-upgrade-required' ||
      inspection.state === 'migration-incomplete' ||
      (proof.phase === 'activating-layout' &&
        inspection.state === 'paper-v2-upgrade-required');
    if (!allowed) {
      throw new PaperLayoutMigrationProofError(
        'The selected Drive root is not in an allowed migration state.',
      );
    }
    if (
      inspection.rootFolderId !== proof.rootFolderId ||
      !sameStringSet(inspection.legacyManagedFileIds, proof.verifiedLegacyFileIds)
    ) {
      throw new PaperRemoteChangedError('layout');
    }
    const grouped = groupByDocumentId(await this.listPaperFolders(signal));
    if (
      [...grouped.keys()].some(
        (documentId) => !proof.targetDocumentIds.includes(documentId),
      ) ||
      [...grouped.values()].some((matches) => matches.length !== 1)
    ) {
      throw new PaperLayoutMigrationProofError(
        'The managed paper folders no longer match the persisted migration scope.',
      );
    }
    const paperFolderIds = new Set([...grouped.values()].flat().map(({ id }) => id));
    for (const fileId of inspection.paperManagedFileIds) {
      if (paperFolderIds.has(fileId)) continue;
      const file = await this.drive.getMetadata(fileId, signal);
      const allowedActivationMarker =
        proof.phase === 'activating-layout' &&
        !file.trashed &&
        file.parents?.length === 1 &&
        file.parents[0] === this.rootFolderId &&
        file.appProperties?.application === '39Note' &&
        file.appProperties.role === 'paper-layout-activation';
      if (!allowedActivationMarker) {
        throw new PaperLayoutMigrationProofError(
          'An unexpected managed artifact was found in the Drive migration root.',
        );
      }
    }
    return inspection;
  }

  private async verifyLayoutMigrationPapers(
    proof: Readonly<PaperLayoutMigrationProof>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.assertLayoutMigrationProof(proof, signal);
    if (!sameStringSet(proof.publishedDocumentIds, proof.targetDocumentIds)) {
      throw new PaperLayoutMigrationIncompleteError();
    }
    const grouped = groupByDocumentId(await this.listPaperFolders(signal));
    if (!sameStringSet([...grouped.keys()], proof.targetDocumentIds)) {
      throw new PaperLayoutMigrationIncompleteError();
    }
    for (const documentId of proof.targetDocumentIds) {
      signal.throwIfAborted();
      const matches = grouped.get(documentId) ?? [];
      if (matches.length !== 1) {
        throw new AmbiguousManagedPaperError(
          documentId,
          matches.map(({ id }) => id),
        );
      }
      const resolved = await this.resolvePaperFolder(matches[0], signal, true);
      if (resolved.heads.length !== 1) {
        throw new PaperManifestIntegrityError(
          'A rebuilt paper does not have exactly one verified immutable head.',
          documentId,
        );
      }
      if (
        resolved.heads[0].manifest.generation.id !==
        proof.publishedGenerationIds[documentId]
      ) {
        throw new PaperRemoteChangedError(documentId);
      }
      foldLoadedHeads(resolved.heads);
      const manifest = resolved.heads[0].manifest;
      await Promise.all([
        this.verifyMigrationPayloadMetadata(
          manifest.state,
          'paper-state',
          manifest.dataFolderId,
          documentId,
          signal,
        ),
        this.verifyMigrationPayloadMetadata(
          manifest.productivity,
          'paper-productivity',
          manifest.dataFolderId,
          documentId,
          signal,
        ),
        this.verifyMigrationPayloadMetadata(
          manifest.conflictJournal,
          'paper-conflicts',
          manifest.dataFolderId,
          documentId,
          signal,
        ),
      ]);
      const summary = await this.summaryForResolved(resolved, undefined);
      if (summary.sourceArtifact) {
        const sourceMetadata = await this.drive.getMetadata(
          summary.sourceArtifact.fileId,
          signal,
        );
        if (
          sourceMetadata.trashed ||
          sourceMetadata.parents?.length !== 1 ||
          sourceMetadata.parents[0] !== summary.paperFolderId ||
          sourceMetadata.appProperties?.role !== summary.sourceArtifact.driveRole ||
          sourceMetadata.appProperties.documentId !== documentId ||
          sourceMetadata.appProperties.sha256 !== summary.sourceArtifact.sha256
        ) {
          throw new PaperManifestIntegrityError(
            'A rebuilt paper source document is outside its verified paper folder.',
            documentId,
          );
        }
      }
      if (summary.sourceArtifact) {
        const sourceBlob = await this.drive.downloadBlob(
          summary.sourceArtifact.fileId,
          signal,
          {
            phase: 'migration-source-verification',
            resource: 'source-document',
            documentId,
          },
        );
        if (
          sourceBlob.size !== summary.sourceArtifact.size ||
          (await sha256Hex(sourceBlob)) !== summary.sourceArtifact.sha256
        ) {
          throw new PaperManifestIntegrityError(
            'A rebuilt paper source document failed immutable verification.',
            documentId,
          );
        }
      }
    }
  }

  private async verifyMigrationPayloadMetadata(
    reference: CloudPayloadReference,
    role: 'paper-state' | 'paper-productivity' | 'paper-conflicts',
    dataFolderId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const metadata = await this.drive.getMetadata(reference.fileId, signal);
    if (
      metadata.trashed ||
      metadata.parents?.length !== 1 ||
      metadata.parents[0] !== dataFolderId ||
      !isPaperRole(metadata, role, documentId) ||
      metadata.appProperties?.sha256 !== reference.sha256
    ) {
      throw new PaperManifestIntegrityError(
        'A rebuilt paper payload is outside its verified data folder.',
        documentId,
      );
    }
  }

  private async verifyLayoutActivationMarker(
    proof: Readonly<PaperLayoutMigrationProof>,
    signal: AbortSignal,
  ): Promise<void> {
    const paperFolders = await this.listPaperFolders(signal);
    const activation = {
      app: '39Note' as const,
      syncLayoutVersion: LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
      paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
      rootFolderId: this.rootFolderId,
      paperFolderIds: paperFolders.map(({ id }) => id).sort(compareCanonicalStrings),
      paperGenerations: Object.fromEntries(
        Object.entries(proof.publishedGenerationIds).sort(([first], [second]) =>
          compareCanonicalStrings(first, second),
        ),
      ),
      legacyManagedFileIds: [...proof.verifiedLegacyFileIds].sort(
        compareCanonicalStrings,
      ),
    };
    const text = stableStringify(activation);
    const sha256 = await sha256Hex(text);
    const name = `paper-layout-v${LEGACY_PAPER_PACKAGE_LAYOUT_VERSION}-${sha256}.json`;
    const query = [
      `'${escapeDriveQueryValue(this.rootFolderId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
      `appProperties has { key='role' and value='paper-layout-activation' }`,
    ].join(' and ');
    const matches = dedupeFiles(await this.drive.listFiles(query, signal)).filter(
      (file) =>
        file.parents?.length === 1 &&
        file.parents[0] === this.rootFolderId &&
        file.appProperties?.application === '39Note' &&
        file.appProperties.role === 'paper-layout-activation' &&
        file.appProperties.sha256 === sha256,
    );
    if (
      matches.length !== 1 ||
      (await this.drive.downloadText(matches[0].id, signal)) !== text
    ) {
      throw new PaperManifestIntegrityError(
        'The Drive layout activation marker could not be verified.',
      );
    }
  }

  publishSelected(
    inputs: readonly { local: LocalPaperPackage; state: PaperSyncState }[],
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<PaperPublishResult[]> {
    return mapWithConcurrency(inputs, PAPER_TRANSFER_CONCURRENCY, ({ local, state }) =>
      this.publishPaper(local, state, signal, onProgress),
    );
  }

  /** Activates the historical v1 -> Paper-v2 rebuild. It never writes over v2+. */
  private async activateRootMetadata(signal: AbortSignal): Promise<void> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal);
    const version = paperRootLayoutVersion(root);
    if (version !== undefined) {
      if (
        version === LEGACY_PAPER_PACKAGE_LAYOUT_VERSION &&
        isPaperV2RootMetadata(root)
      ) {
        return;
      }
      throw new PaperUnsupportedLayoutError(
        Number.isSafeInteger(version) ? version : undefined,
      );
    }
    const updated = await this.drive.updateMetadata(
      root.id,
      {
        appProperties: {
          ...(root.appProperties ?? {}),
          application: '39Note',
          role: 'root',
          syncSchema: '1',
          layoutVersion: String(LEGACY_PAPER_PACKAGE_LAYOUT_VERSION),
          paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
        },
      },
      signal,
    );
    if (
      updated.id !== root.id ||
      updated.trashed ||
      updated.appProperties?.application !== '39Note' ||
      updated.appProperties.role !== 'root' ||
      updated.appProperties.layoutVersion !==
        String(LEGACY_PAPER_PACKAGE_LAYOUT_VERSION) ||
      updated.appProperties.paperProtocolVersion !== String(PAPER_SYNC_PROTOCOL_VERSION)
    ) {
      throw new PaperManifestIntegrityError(
        'Google Drive did not activate the paper-centric layout.',
      );
    }
  }

  private async ensureUsableLayout(signal: AbortSignal): Promise<void> {
    const layout = await this.detectLayout(signal);
    if (layout.state === 'paper-v3') return;
    if (
      layout.state === 'legacy-upgrade-required' ||
      layout.state === 'paper-v2-upgrade-required'
    ) {
      throw new PaperLayoutUpgradeRequiredError();
    }
    if (layout.state === 'migration-incomplete') {
      throw new PaperLayoutMigrationIncompleteError();
    }
    if (layout.state === 'unsupported-layout') {
      throw new PaperUnsupportedLayoutError(layout.detectedLayoutVersion);
    }
    await this.initializeEmptyLayout(signal);
  }

  private async activateV3RootMetadata(
    controlFolderId: string,
    migrationCompletionId: string,
    signal: AbortSignal,
    requireUnversionedRoot = false,
  ): Promise<void> {
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'v3-layout-activation',
      resource: 'root',
    });
    if (root.id !== this.rootFolderId || !isOwnedManagedPaperRootMetadata(root)) {
      throw new PaperRepositoryError(
        'drive-root-invalid',
        'The selected Google Drive folder is not a verified 39Note sync root.',
      );
    }
    const version = paperRootLayoutVersion(root);
    if (isPaperV3RootMetadata(root)) {
      if (
        root.appProperties!.controlFolderId !== controlFolderId ||
        root.appProperties!.migrationCompletionId !== migrationCompletionId
      ) {
        throw new PaperV3ControlIntegrityError(
          'The active v3 root is bound to different migration evidence.',
        );
      }
      await this.presence.verifyActivatedControl(
        controlFolderId,
        migrationCompletionId,
        signal,
      );
      return;
    }
    if (
      requireUnversionedRoot
        ? version !== undefined
        : version !== LEGACY_PAPER_PACKAGE_LAYOUT_VERSION ||
          !isPaperV2RootMetadata(root)
    ) {
      throw new PaperUnsupportedLayoutError(
        Number.isSafeInteger(version) ? version : undefined,
      );
    }
    await this.presence.verifyActivatedControl(
      controlFolderId,
      migrationCompletionId,
      signal,
    );
    const updated = await this.drive.updateMetadata(
      root.id,
      {
        appProperties: {
          ...(root.appProperties ?? {}),
          application: '39Note',
          role: 'root',
          syncSchema: '1',
          layoutVersion: String(SYNC_LAYOUT_VERSION),
          paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
          presenceProtocolVersion: String(PAPER_PRESENCE_PROTOCOL_VERSION),
          controlFolderId,
          migrationCompletionId,
        },
      },
      signal,
      { phase: 'v3-layout-activation', resource: 'root' },
    );
    if (updated.id !== root.id) {
      throw new PaperV3ControlIntegrityError(
        'Google Drive changed the v3 root identity.',
      );
    }
    const verified = await this.drive.getMetadata(root.id, signal, {
      phase: 'v3-layout-activation-verification',
      resource: 'root',
    });
    if (!isPaperV3RootMetadata(verified)) {
      throw new PaperV3ControlIntegrityError(
        'Google Drive did not retain the exact v3 root metadata.',
      );
    }
    await this.presence.verifyActivatedControl(
      controlFolderId,
      migrationCompletionId,
      signal,
    );
  }

  private async listPaperFolders(
    signal: AbortSignal,
    documentId?: string,
  ): Promise<DriveFileMetadata[]> {
    const query = [
      `'${escapeDriveQueryValue(this.rootFolderId)}' in parents`,
      'trashed=false',
      `mimeType='${FOLDER_MIME}'`,
      `appProperties has { key='application' and value='39Note' }`,
      `appProperties has { key='role' and value='paper-folder' }`,
      ...(documentId
        ? [
            `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
          ]
        : []),
    ].join(' and ');
    return dedupeFiles(
      await this.drive.listFiles(query, signal, {
        phase: 'paper-discovery',
        resource: 'paper-folder',
        ...(documentId ? { documentId } : {}),
      }),
    ).filter((file) => isPaperFolder(file, this.rootFolderId, documentId));
  }

  private async resolvePaperFromSummary(
    summary: PaperCloudSummary,
    signal: AbortSignal,
    loadPayloads: boolean,
    reuseVerifiedManifests = false,
  ): Promise<ResolvedPaper> {
    const folder = await this.drive.getMetadata(summary.paperFolderId, signal);
    if (
      !isPaperFolder(folder, this.rootFolderId) ||
      folder.appProperties?.documentId !== summary.documentId
    ) {
      throw new PaperRemoteChangedError(summary.documentId);
    }
    if (!summary.dataFolderId) throw new PaperRemoteChangedError(summary.documentId);
    const dataFolder = await this.drive.getMetadata(summary.dataFolderId, signal);
    if (!isPaperDataFolder(dataFolder, folder.id, summary.documentId)) {
      throw new PaperRemoteChangedError(summary.documentId);
    }
    return this.resolvePaperFolder(
      folder,
      signal,
      loadPayloads,
      dataFolder,
      reuseVerifiedManifests,
    );
  }

  private async resolvePaperFolder(
    folder: DriveFileMetadata,
    signal: AbortSignal,
    loadPayloads: boolean,
    knownDataFolder?: DriveFileMetadata,
    reuseVerifiedManifests = false,
  ): Promise<ResolvedPaper> {
    const documentId = folder.appProperties?.documentId;
    if (!documentId || !isPaperFolder(folder, this.rootFolderId)) {
      throw new PaperManifestIntegrityError('A managed paper folder is invalid.');
    }
    const dataFolder =
      knownDataFolder ?? (await this.findSingleDataFolder(folder, documentId, signal));
    const generations = await this.loadManifestGenerations(
      documentId,
      folder,
      dataFolder,
      signal,
      loadPayloads,
      reuseVerifiedManifests,
    );
    const heads = derivePaperHeads(generations, documentId);
    return { folder, dataFolder, generations, heads };
  }

  private async findSingleDataFolder(
    paperFolder: Pick<DriveFileMetadata, 'id'>,
    documentId: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const query = [
      `'${escapeDriveQueryValue(paperFolder.id)}' in parents`,
      'trashed=false',
      `mimeType='${FOLDER_MIME}'`,
      `appProperties has { key='role' and value='paper-data' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
    ].join(' and ');
    const matches = dedupeFiles(
      await this.drive.listFiles(query, signal, {
        phase: 'manifest-head-resolution',
        resource: 'data-folder',
        documentId,
      }),
    ).filter((file) => isPaperDataFolder(file, paperFolder.id, documentId));
    if (matches.length !== 1) {
      throw new AmbiguousManagedPaperError(
        documentId,
        matches.map(({ id }) => id),
      );
    }
    return matches[0];
  }

  private async loadManifestGenerations(
    documentId: string,
    folder: DriveFileMetadata,
    dataFolder: DriveFileMetadata,
    signal: AbortSignal,
    loadPayloads: boolean,
    reuseVerifiedManifests: boolean,
  ): Promise<LoadedPaperGeneration[]> {
    const query = [
      `'${escapeDriveQueryValue(dataFolder.id)}' in parents`,
      'trashed=false',
      `appProperties has { key='role' and value='paper-manifest-generation' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
    ].join(' and ');
    const files = dedupeFiles(
      await this.drive.listFiles(query, signal, {
        phase: 'manifest-head-resolution',
        resource: 'manifest',
        documentId,
      }),
    );
    const generations = await mapWithConcurrency(
      files,
      PAPER_METADATA_CONCURRENCY,
      async (file) =>
        this.loadManifestFile(
          file,
          documentId,
          folder,
          dataFolder,
          signal,
          reuseVerifiedManifests,
        ),
    );
    if (!loadPayloads) return generations;

    return this.loadCurrentHeadPayloads(generations, documentId, signal);
  }

  private async loadCurrentHeadPayloads(
    generations: readonly LoadedPaperGeneration[],
    documentId: string,
    signal: AbortSignal,
    operationCache?: PaperDownloadOperationCache,
  ): Promise<LoadedPaperGeneration[]> {
    // Ancestry needs every manifest, but reconstructing the current package needs
    // only current heads. Deduplicate shared immutable payload references per call.
    const heads = derivePaperHeads(generations, documentId);
    const payloads: Map<
      string,
      Promise<CloudEntityPayload>
    > = operationCache?.verifiedPayloads ?? new Map();
    const conflicts: Map<
      string,
      Promise<PaperConflictPayload>
    > = operationCache?.verifiedConflictPayloads ?? new Map();
    const loadedHeads = await mapWithConcurrency(
      heads,
      PAPER_METADATA_CONCURRENCY,
      async (loaded) => {
        const stateKey = `state:${loaded.manifest.state.fileId}:${loaded.manifest.state.sha256}`;
        const productivityKey = `productivity:${loaded.manifest.productivity.fileId}:${loaded.manifest.productivity.sha256}`;
        const conflictKey = `conflicts:${loaded.manifest.conflictJournal.fileId}:${loaded.manifest.conflictJournal.sha256}`;
        const state =
          payloads.get(stateKey) ??
          this.downloadPayload(
            loaded.manifest.state,
            'document-state',
            documentId,
            signal,
          );
        payloads.set(stateKey, state);
        const productivity =
          payloads.get(productivityKey) ??
          this.downloadPayload(
            loaded.manifest.productivity,
            'productivity-data',
            documentId,
            signal,
          );
        payloads.set(productivityKey, productivity);
        const conflictPayload =
          conflicts.get(conflictKey) ??
          this.downloadConflictPayload(
            loaded.manifest.conflictJournal,
            documentId,
            signal,
          );
        conflicts.set(conflictKey, conflictPayload);
        const [resolvedState, resolvedProductivity, resolvedConflicts] =
          await Promise.all([state, productivity, conflictPayload]);
        const conflictIds = resolvedConflicts.conflicts.map((conflict) => conflict.id);
        if (!sameStringSet(conflictIds, loaded.manifest.conflictIds)) {
          throw new PaperManifestIntegrityError(
            'A paper conflict journal does not match its immutable manifest.',
            documentId,
          );
        }
        return {
          ...loaded,
          snapshot: combinePaperPayloads(
            loaded.manifest,
            resolvedState,
            resolvedProductivity,
          ),
          conflicts: resolvedConflicts.conflicts,
        };
      },
    );
    const loadedByGeneration = new Map(
      loadedHeads.map((loaded) => [loaded.manifest.generation.id, loaded]),
    );
    return generations.map(
      (generation) =>
        loadedByGeneration.get(generation.manifest.generation.id) ?? generation,
    );
  }

  private async loadManifestFile(
    file: DriveFileMetadata,
    documentId: string,
    folder: DriveFileMetadata,
    dataFolder: DriveFileMetadata,
    signal: AbortSignal,
    reuseVerifiedManifest: boolean,
  ): Promise<LoadedPaperGeneration> {
    if (!isPaperManifestFile(file, dataFolder.id, documentId)) {
      throw new PaperManifestIntegrityError(
        'A managed paper manifest has invalid Drive metadata.',
        documentId,
      );
    }
    const cached = this.verifiedManifestCache.get(file.id);
    if (
      reuseVerifiedManifest &&
      cached &&
      sameImmutableDriveEvidence(cached.file, file) &&
      cached.manifest.documentId === documentId &&
      cached.manifest.paperFolderId === folder.id &&
      cached.manifest.dataFolderId === dataFolder.id
    ) {
      return { file, manifest: cached.manifest };
    }
    const text = await this.mediaGate.run(() =>
      this.drive.downloadText(file.id, signal, {
        phase: 'manifest-head-resolution',
        resource: 'manifest',
        documentId,
      }),
    );
    let manifest: PaperCloudManifest;
    try {
      manifest = parsePaperCloudManifest(text);
    } catch (error) {
      throw new PaperManifestIntegrityError(
        'A managed paper manifest could not be validated.',
        documentId,
        error,
      );
    }
    if (
      !(await verifyPaperManifestGeneration(manifest)) ||
      text !== stableStringify(manifest) ||
      manifest.documentId !== documentId ||
      manifest.paperFolderId !== folder.id ||
      manifest.dataFolderId !== dataFolder.id ||
      paperPackageLayoutVersion(file) !== manifest.syncLayoutVersion ||
      file.appProperties?.manifestStorage !== manifest.manifestStorage ||
      file.name !== manifestGenerationName(manifest.generation.id) ||
      file.appProperties?.generationId !== manifest.generation.id
    ) {
      throw new PaperManifestIntegrityError(
        'A managed paper manifest failed immutable verification.',
        documentId,
      );
    }
    if (hasImmutableDriveEvidence(file)) {
      this.verifiedManifestCache.set(file.id, { file, manifest });
    } else {
      this.verifiedManifestCache.delete(file.id);
    }
    return { file, manifest };
  }

  private async downloadPayload(
    reference: CloudPayloadReference,
    logicalType: 'document-state' | 'productivity-data',
    documentId: string,
    signal: AbortSignal,
  ): Promise<CloudEntityPayload> {
    try {
      const blob = await this.mediaGate.run(() =>
        this.drive.downloadBlob(reference.fileId, signal, {
          phase: 'payload-transfer',
          resource: 'payload',
          documentId,
        }),
      );
      return await this.drive.measureOperationPhase(
        'json-payload-verification',
        () => parsePaperPayloadBlob(blob, reference.sha256, logicalType, documentId),
        { documentId, bytesProcessed: blob.size },
      );
    } catch (error) {
      if (isDriveOperationFailure(error)) throw error;
      if (error instanceof CloudPayloadPartitionError) {
        throw new PaperPayloadPartitionError(documentId, error);
      }
      throw new PaperManifestIntegrityError(
        'A selected paper payload failed integrity verification.',
        documentId,
        error,
      );
    }
  }

  private async downloadConflictPayload(
    reference: CloudPayloadReference,
    documentId: string,
    signal: AbortSignal,
  ) {
    try {
      const blob = await this.mediaGate.run(() =>
        this.drive.downloadBlob(reference.fileId, signal, {
          phase: 'payload-transfer',
          resource: 'payload',
          documentId,
        }),
      );
      return await this.drive.measureOperationPhase(
        'json-payload-verification',
        () => parsePaperConflictPayloadBlob(blob, reference.sha256, documentId),
        { documentId, bytesProcessed: blob.size },
      );
    } catch (error) {
      if (isDriveOperationFailure(error)) throw error;
      throw new PaperManifestIntegrityError(
        'A selected paper conflict journal failed integrity verification.',
        documentId,
        error,
      );
    }
  }

  private async summaryForResolved(
    resolved: ResolvedPaper,
    state: PaperSyncState | undefined,
  ): Promise<PaperCloudSummary> {
    if (resolved.heads.length === 0) {
      throw new PaperManifestIntegrityError(
        'A managed paper folder has no valid immutable head.',
        resolved.folder.appProperties?.documentId,
      );
    }
    const ordered = [...resolved.heads].sort((first, second) =>
      compareCanonicalStrings(
        first.manifest.generation.id,
        second.manifest.generation.id,
      ),
    );
    const first = ordered[0].manifest;
    const firstSource = sourceArtifactFromManifest(first);
    const renderedPrintPdf = selectRenderedPrintPdfDescriptor(ordered);
    for (const head of ordered.slice(1)) {
      const candidateSource = sourceArtifactFromManifest(head.manifest);
      if (
        Boolean(firstSource) !== Boolean(candidateSource) ||
        (firstSource &&
          candidateSource &&
          !sourceArtifactsHaveSameIdentity(firstSource, candidateSource))
      ) {
        throw new PaperSourcePdfConflictError(first.documentId);
      }
    }
    const headIds = ordered.map(({ manifest }) => manifest.generation.id);
    const managedFileIds = [
      resolved.folder.id,
      resolved.dataFolder.id,
      ...resolved.generations.flatMap(({ file, manifest }) => [
        file.id,
        manifest.state.fileId,
        manifest.productivity.fileId,
        manifest.conflictJournal.fileId,
        ...(sourceArtifactFromManifest(manifest)
          ? [sourceArtifactFromManifest(manifest)!.fileId]
          : []),
        ...(manifest.renderedPrintPdf ? [manifest.renderedPrintPdf.fileId] : []),
        ...(manifest.recoveryEvidence ?? []).flatMap((evidence) => [
          evidence.expected.fileId,
          ...(evidence.observed ? [evidence.observed.fileId] : []),
          evidence.merged.fileId,
        ]),
      ]),
    ];
    const latestModifiedTime = Math.max(
      ...ordered.map(({ file }) => Date.parse(file.modifiedTime ?? '') || 0),
    );
    const localAvailability = state?.availability ?? 'cloud-only';
    return {
      documentId: first.documentId,
      displayName: first.displayName,
      deleted: ordered.every(({ manifest }) => manifest.deleted),
      paperFolderId: first.paperFolderId,
      dataFolderId: first.dataFolderId,
      headIds,
      headSetId: await headSetId(headIds),
      managedFileIds: [...new Set(managedFileIds)].sort(compareCanonicalStrings),
      ...(latestModifiedTime > 0 ? { publishedAt: latestModifiedTime } : {}),
      ...(first.writer.deviceLabel ? { writerLabel: first.writer.deviceLabel } : {}),
      ...(firstSource ? { sourceArtifact: firstSource } : {}),
      ...(firstSource?.documentType === 'pdf' ? { sourcePdf: firstSource } : {}),
      ...(renderedPrintPdf ? { renderedPrintPdf } : {}),
      localAvailability,
      status:
        new Set(ordered.map(({ manifest }) => manifest.deleted)).size > 1
          ? 'needs-attention'
          : derivePaperStatus(state, headIds),
    };
  }

  private async ensurePaperFolder(
    documentId: string,
    displayName: string,
    state: PaperSyncState,
    signal: AbortSignal,
    requiredPaperFolderId?: string,
  ): Promise<DriveFileMetadata> {
    if (requiredPaperFolderId) {
      try {
        const exact = await this.drive.getMetadata(requiredPaperFolderId, signal, {
          phase: 'paper-folder-resolution',
          resource: 'paper-folder',
          documentId,
        });
        if (!isPaperFolder(exact, this.rootFolderId, documentId)) {
          throw new PaperRemoteChangedError(documentId);
        }
        state.driveFiles.paperFolderId = exact.id;
        return exact;
      } catch (error) {
        if (isInaccessibleDriveIdentity(error)) {
          throw new PaperRemoteChangedError(documentId);
        }
        throw error;
      }
    }
    const query = [
      `'${escapeDriveQueryValue(this.rootFolderId)}' in parents`,
      'trashed=false',
      `mimeType='${FOLDER_MIME}'`,
      `appProperties has { key='role' and value='paper-folder' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
    ].join(' and ');
    const matches = dedupeFiles(
      await this.drive.listFiles(query, signal, {
        phase: 'paper-folder-resolution',
        resource: 'paper-folder',
        documentId,
      }),
    ).filter((file) => isPaperFolder(file, this.rootFolderId, documentId));
    if (matches.length > 1) {
      throw new AmbiguousManagedPaperError(
        documentId,
        matches.map(({ id }) => id),
      );
    }
    const folderCandidate =
      matches[0] ??
      (await this.drive.createFolder(
        normalizePaperFolderName(displayName),
        this.rootFolderId,
        paperAppProperties('paper-folder', documentId),
        signal,
        {
          phase: 'paper-folder-publication',
          resource: 'paper-folder',
          documentId,
        },
      ));
    const folder = await this.drive.getMetadata(folderCandidate.id, signal, {
      phase: 'paper-folder-verification',
      resource: 'paper-folder',
      documentId,
    });
    if (!isPaperFolder(folder, this.rootFolderId, documentId)) {
      throw new PaperManifestIntegrityError(
        'Google Drive did not retain the paper folder in the selected root.',
        documentId,
      );
    }
    state.driveFiles.paperFolderId = folder.id;
    return folder;
  }

  private async ensureDataFolder(
    documentId: string,
    folder: DriveFileMetadata,
    state: PaperSyncState,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const cachedDataFolderId = state.driveFiles.dataFolderId;
    if (cachedDataFolderId) {
      try {
        const exact = await this.drive.getMetadata(cachedDataFolderId, signal, {
          phase: 'data-folder-resolution',
          resource: 'data-folder',
          documentId,
        });
        if (isPaperDataFolder(exact, folder.id, documentId)) return exact;
      } catch (error) {
        if (!isInaccessibleDriveIdentity(error)) throw error;
      }
    }
    const query = [
      `'${escapeDriveQueryValue(folder.id)}' in parents`,
      'trashed=false',
      `mimeType='${FOLDER_MIME}'`,
      `appProperties has { key='role' and value='paper-data' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
    ].join(' and ');
    const matches = dedupeFiles(
      await this.drive.listFiles(query, signal, {
        phase: 'data-folder-resolution',
        resource: 'data-folder',
        documentId,
      }),
    ).filter((file) => isPaperDataFolder(file, folder.id, documentId));
    if (matches.length > 1) {
      throw new AmbiguousManagedPaperError(
        documentId,
        matches.map(({ id }) => id),
      );
    }
    const dataFolderCandidate =
      matches[0] ??
      (await this.drive.createFolder(
        PAPER_DATA_NAME,
        folder.id,
        paperAppProperties('paper-data', documentId),
        signal,
        {
          phase: 'data-folder-publication',
          resource: 'data-folder',
          documentId,
        },
      ));
    const dataFolder = await this.drive.getMetadata(dataFolderCandidate.id, signal, {
      phase: 'data-folder-verification',
      resource: 'data-folder',
      documentId,
    });
    if (!isPaperDataFolder(dataFolder, folder.id, documentId)) {
      throw new PaperManifestIntegrityError(
        'Google Drive did not retain the paper data folder in its exact parent.',
        documentId,
      );
    }
    state.driveFiles.dataFolderId = dataFolder.id;
    return dataFolder;
  }

  private async putPayload(
    role: 'paper-state' | 'paper-productivity',
    baseName: string,
    encoded: { text: string; sha256: string },
    prior: CloudPayloadReference | undefined,
    dataFolderId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<{ reference: CloudPayloadReference; created: boolean }> {
    const logicalType = role === 'paper-state' ? 'document-state' : 'productivity-data';
    if (prior?.sha256 === encoded.sha256) {
      return { reference: prior, created: false };
    }
    const name = payloadGenerationName(baseName, encoded.sha256);
    const query = [
      `'${escapeDriveQueryValue(dataFolderId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
      `appProperties has { key='role' and value='${role}' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
    ].join(' and ');
    const reusableCandidates = dedupeFiles(
      await this.drive.listFiles(query, signal, {
        phase: 'payload-publication',
        resource: 'payload',
        documentId,
      }),
    ).sort((first, second) => compareCanonicalStrings(first.id, second.id));
    const verifiedCandidates = await Promise.all(
      reusableCandidates.map(async (candidate) => {
        try {
          await parsePaperPayloadBlob(
            await this.mediaGate.run(() =>
              this.drive.downloadBlob(candidate.id, signal, {
                phase: 'payload-reuse-verification',
                resource: 'payload',
                documentId,
              }),
            ),
            encoded.sha256,
            logicalType,
            documentId,
          );
          return candidate;
        } catch {
          signal.throwIfAborted();
          return undefined;
        }
      }),
    );
    const reusableCandidate = verifiedCandidates.find(
      (candidate): candidate is DriveFileMetadata => candidate !== undefined,
    );
    if (reusableCandidate) {
      return {
        reference: { fileId: reusableCandidate.id, sha256: encoded.sha256 },
        created: false,
      };
    }
    const uploaded = await this.drive.uploadFile(
      name,
      new Blob([encoded.text], { type: 'application/json' }),
      {
        parents: [dataFolderId],
        appProperties: {
          ...paperAppProperties(role, documentId),
          sha256: encoded.sha256,
        },
      },
      signal,
      undefined,
      {
        phase: 'payload-publication',
        resource: 'payload',
        documentId,
      },
    );
    const [, metadata] = await Promise.all([
      this.mediaGate
        .run(() =>
          this.drive.downloadBlob(uploaded.id, signal, {
            phase: 'post-publish-verification',
            resource: 'payload',
            documentId,
          }),
        )
        .then((blob) =>
          parsePaperPayloadBlob(blob, encoded.sha256, logicalType, documentId),
        ),
      this.drive.getMetadata(uploaded.id, signal, {
        phase: 'post-publish-verification',
        resource: 'payload',
        documentId,
      }),
    ]);
    if (
      metadata.id !== uploaded.id ||
      metadata.trashed ||
      metadata.parents?.length !== 1 ||
      metadata.parents[0] !== dataFolderId ||
      metadata.appProperties?.role !== role ||
      metadata.appProperties.documentId !== documentId ||
      metadata.appProperties.sha256 !== encoded.sha256
    ) {
      throw new PaperManifestIntegrityError(
        'Google Drive did not retain an exact paper payload.',
        documentId,
      );
    }
    return {
      reference: { fileId: uploaded.id, sha256: encoded.sha256 },
      created: true,
    };
  }

  private async putConflictPayload(
    baseName: string,
    encoded: { text: string; sha256: string },
    prior: CloudPayloadReference | undefined,
    dataFolderId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<{ reference: CloudPayloadReference; created: boolean }> {
    if (prior?.sha256 === encoded.sha256) {
      return { reference: prior, created: false };
    }
    const role = 'paper-conflicts';
    const name = payloadGenerationName(baseName, encoded.sha256);
    const query = [
      `'${escapeDriveQueryValue(dataFolderId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
      `appProperties has { key='role' and value='${role}' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
    ].join(' and ');
    const reusableCandidates = dedupeFiles(
      await this.drive.listFiles(query, signal, {
        phase: 'payload-publication',
        resource: 'payload',
        documentId,
      }),
    ).sort((first, second) => compareCanonicalStrings(first.id, second.id));
    const verifiedCandidates = await Promise.all(
      reusableCandidates.map(async (candidate) => {
        try {
          await parsePaperConflictPayloadBlob(
            await this.mediaGate.run(() =>
              this.drive.downloadBlob(candidate.id, signal, {
                phase: 'payload-reuse-verification',
                resource: 'payload',
                documentId,
              }),
            ),
            encoded.sha256,
            documentId,
          );
          return candidate;
        } catch {
          signal.throwIfAborted();
          return undefined;
        }
      }),
    );
    const reusableCandidate = verifiedCandidates.find(
      (candidate): candidate is DriveFileMetadata => candidate !== undefined,
    );
    if (reusableCandidate) {
      return {
        reference: { fileId: reusableCandidate.id, sha256: encoded.sha256 },
        created: false,
      };
    }
    const uploaded = await this.drive.uploadFile(
      name,
      new Blob([encoded.text], { type: 'application/json' }),
      {
        parents: [dataFolderId],
        appProperties: {
          ...paperAppProperties(role, documentId),
          sha256: encoded.sha256,
        },
      },
      signal,
      undefined,
      {
        phase: 'payload-publication',
        resource: 'payload',
        documentId,
      },
    );
    const [, metadata] = await Promise.all([
      this.mediaGate
        .run(() =>
          this.drive.downloadBlob(uploaded.id, signal, {
            phase: 'post-publish-verification',
            resource: 'payload',
            documentId,
          }),
        )
        .then((blob) =>
          parsePaperConflictPayloadBlob(blob, encoded.sha256, documentId),
        ),
      this.drive.getMetadata(uploaded.id, signal, {
        phase: 'post-publish-verification',
        resource: 'payload',
        documentId,
      }),
    ]);
    if (
      metadata.id !== uploaded.id ||
      metadata.trashed ||
      metadata.parents?.length !== 1 ||
      metadata.parents[0] !== dataFolderId ||
      metadata.appProperties?.role !== role ||
      metadata.appProperties.documentId !== documentId ||
      metadata.appProperties.sha256 !== encoded.sha256
    ) {
      throw new PaperManifestIntegrityError(
        'Google Drive did not retain an exact paper conflict journal.',
        documentId,
      );
    }
    return {
      reference: { fileId: uploaded.id, sha256: encoded.sha256 },
      created: true,
    };
  }

  private async verifyRestoredPackageSource(
    local: LocalPaperPackage,
    state: PaperSyncState,
    resolved: ResolvedPaper,
    signal: AbortSignal,
  ): Promise<NonNullable<PaperPublicationOptions['knownSource']>> {
    const localDescriptor = sourceArtifactFromLocalPackage(local);
    const remoteDescriptors = resolved.heads.flatMap(({ manifest }) => {
      const source = sourceArtifactFromManifest(manifest);
      return source ? [source] : [];
    });
    const remoteIdentities = new Set(
      remoteDescriptors.map(
        ({ documentType, mimeType, sha256, size }) =>
          `${documentType}:${mimeType}:${sha256}:${size}`,
      ),
    );
    if (
      remoteIdentities.size > 1 ||
      (localDescriptor &&
        remoteDescriptors.some(
          (descriptor) => !sourceArtifactsHaveSameIdentity(descriptor, localDescriptor),
        ))
    ) {
      throw new PaperSourcePdfConflictError(local.documentId);
    }
    const descriptor = remoteDescriptors[0];
    if (localDescriptor && !descriptor) {
      throw new PaperManifestIntegrityError(
        'The prior Drive package does not contain the expected source document.',
        local.documentId,
      );
    }
    if (!descriptor) return { uploaded: false };
    const evidence = await this.verifyReusableSourceArtifact(
      descriptor,
      state.driveFiles.sourceArtifactEvidence ??
        (descriptor.documentType === 'pdf'
          ? state.driveFiles.sourcePdfEvidence
          : undefined),
      resolved.folder.id,
      local.documentId,
      signal,
    );
    return {
      descriptor,
      uploaded: false,
      ...(evidence ? { evidence } : {}),
    };
  }

  private async resolveSourceArtifact(
    localSource: LocalSyncSourceArtifact | undefined,
    heads: readonly LoadedPaperGeneration[],
    knownEvidence: PaperDriveFileEvidence | undefined,
    paperFolderId: string,
    documentId: string,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<{
    descriptor?: ExactPaperSourceArtifact;
    uploaded: boolean;
    evidence?: PaperDriveFileEvidence;
  }> {
    const descriptor = localSource
      ? withoutExactDriveIdentity(withoutSourceBlob(localSource))
      : undefined;
    const remoteDescriptors = heads.flatMap(({ manifest }) => {
      const source = sourceArtifactFromManifest(manifest);
      return source ? [source] : [];
    });
    if (
      new Set(
        remoteDescriptors.map(
          ({ documentType, mimeType, sha256, size }) =>
            `${documentType}:${mimeType}:${sha256}:${size}`,
        ),
      ).size > 1 ||
      (descriptor &&
        remoteDescriptors.some(
          (remote) => !sourceArtifactsHaveSameIdentity(remote, descriptor),
        ))
    ) {
      throw new PaperSourcePdfConflictError(documentId);
    }
    const reusable = remoteDescriptors.find(
      (remote) => descriptor && sourceArtifactsHaveSameIdentity(remote, descriptor),
    );
    if (reusable) {
      const evidence = await this.verifyReusableSourceArtifact(
        reusable,
        knownEvidence,
        paperFolderId,
        documentId,
        signal,
      );
      return {
        descriptor: reusable,
        uploaded: false,
        ...(evidence ? { evidence } : {}),
      };
    }
    if (!descriptor && remoteDescriptors[0]) {
      return { descriptor: remoteDescriptors[0], uploaded: false };
    }
    if (!descriptor) return { uploaded: false };
    const driveRole = driveRoleForNewSource(descriptor);
    const orphanQuery = [
      `'${escapeDriveQueryValue(paperFolderId)}' in parents`,
      'trashed=false',
      `appProperties has { key='role' and value='${driveRole}' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
      `appProperties has { key='sha256' and value='${descriptor.sha256}' }`,
    ].join(' and ');
    const orphanCandidates = dedupeFiles(
      await this.drive.listFiles(orphanQuery, signal, {
        phase: 'source-document-resolution',
        resource: 'source-document',
        documentId,
      }),
    ).sort((first, second) => compareCanonicalStrings(first.id, second.id));
    for (const candidate of orphanCandidates) {
      if (
        candidate.trashed ||
        candidate.parents?.length !== 1 ||
        candidate.parents[0] !== paperFolderId ||
        !isPaperRole(candidate, driveRole, documentId) ||
        candidate.appProperties?.sha256 !== descriptor.sha256
      ) {
        continue;
      }
      const blob = await this.mediaGate.run(() =>
        this.drive.downloadBlob(candidate.id, signal, {
          phase: 'source-document-reuse-verification',
          resource: 'source-document',
          documentId,
        }),
      );
      if (
        blob.size === descriptor.size &&
        (await sha256Hex(blob)) === descriptor.sha256
      ) {
        const candidateDescriptor: ExactPaperSourceArtifact = {
          ...descriptor,
          fileId: candidate.id,
          driveRole,
        };
        const metadata = await this.drive.getMetadata(candidate.id, signal, {
          phase: 'source-document-verification',
          resource: 'source-document',
          documentId,
        });
        assertSourceArtifactMetadata(
          metadata,
          candidateDescriptor,
          paperFolderId,
          documentId,
        );
        const listedEvidence = paperDriveFileEvidence(candidate);
        const evidence = paperDriveFileEvidence(metadata);
        if (
          listedEvidence &&
          evidence &&
          !samePaperDriveFileEvidence(listedEvidence, evidence)
        ) {
          throw new PaperRemoteChangedError(documentId);
        }
        return {
          descriptor: candidateDescriptor,
          uploaded: false,
          ...(evidence ? { evidence } : {}),
        };
      }
    }
    if (!localSource || localSource.documentId !== documentId) {
      throw new Error(`Local source document ${documentId} is unavailable.`);
    }
    if (
      localSource.size !== descriptor.size ||
      localSource.blob.size !== descriptor.size ||
      (await sha256Hex(localSource.blob)) !== descriptor.sha256
    ) {
      throw new PaperManifestIntegrityError(
        'The local paper source document failed validation.',
        documentId,
      );
    }
    onProgress?.({
      documentId,
      phase: 'uploading',
      completed: 0,
      total: 1,
      bytesCompleted: 0,
      bytesTotal: localSource.size,
      detail: localSource.fileName,
    });
    const uploaded = await this.drive.uploadFile(
      localSource.fileName,
      localSource.blob,
      {
        parents: [paperFolderId],
        appProperties: {
          ...paperAppProperties(driveRole, documentId),
          sha256: descriptor.sha256,
        },
      },
      signal,
      (completed, total) =>
        onProgress?.({
          documentId,
          phase: 'uploading',
          completed: 0,
          total: 1,
          bytesCompleted: completed,
          bytesTotal: total,
          detail: localSource.fileName,
        }),
      {
        phase: 'source-document-publication',
        resource: 'source-document',
        documentId,
      },
    );
    const uploadedDescriptor: ExactPaperSourceArtifact = {
      ...descriptor,
      fileId: uploaded.id,
      driveRole,
    };
    let verifiedMetadata = uploaded;
    assertSourceArtifactMetadata(
      verifiedMetadata,
      uploadedDescriptor,
      paperFolderId,
      documentId,
    );
    if (normalizedDriveSha256(uploaded.sha256Checksum) !== descriptor.sha256) {
      const verifiedBlob = await this.mediaGate.run(() =>
        this.drive.downloadBlob(uploaded.id, signal, {
          phase: 'source-document-verification',
          resource: 'source-document',
          documentId,
        }),
      );
      verifiedMetadata = await this.drive.getMetadata(uploaded.id, signal, {
        phase: 'source-document-verification',
        resource: 'source-document',
        documentId,
      });
      assertSourceArtifactMetadata(
        verifiedMetadata,
        uploadedDescriptor,
        paperFolderId,
        documentId,
      );
      if (
        verifiedBlob.size !== descriptor.size ||
        (await sha256Hex(verifiedBlob)) !== descriptor.sha256
      ) {
        throw new PaperManifestIntegrityError(
          'Google Drive did not retain the exact source document.',
          documentId,
        );
      }
    }
    onProgress?.({
      documentId,
      phase: 'uploading',
      completed: 1,
      total: 1,
      bytesCompleted: descriptor.size,
      bytesTotal: descriptor.size,
    });
    return {
      descriptor: uploadedDescriptor,
      uploaded: true,
      ...(paperDriveFileEvidence(verifiedMetadata)
        ? { evidence: paperDriveFileEvidence(verifiedMetadata) }
        : {}),
    };
  }

  private async resolveRenderedPrintPdf(
    localArtifact: StoredRenderedPrintPdf | undefined,
    heads: readonly LoadedPaperGeneration[],
    preserveRemoteWhenLocalMissing: boolean,
    paperFolderId: string,
    documentId: string,
    signal: AbortSignal,
    onProgress?: (progress: PaperTransferProgress) => void,
  ): Promise<{
    descriptor?: RenderedPrintPdfDescriptor;
    uploaded: boolean;
  }> {
    const remote = selectRenderedPrintPdfDescriptor(heads);
    if (!localArtifact) {
      if (!preserveRemoteWhenLocalMissing || !remote) return { uploaded: false };
      await this.verifyReusableRenderedPrintPdf(
        remote,
        paperFolderId,
        documentId,
        signal,
      );
      return { descriptor: remote, uploaded: false };
    }

    const localDescriptor = renderedPrintPdfDescriptorWithoutFileId(localArtifact);
    if (remote && sameRenderedPrintPdfContent(remote, localDescriptor)) {
      await this.verifyReusableRenderedPrintPdf(
        remote,
        paperFolderId,
        documentId,
        signal,
      );
      return { descriptor: remote, uploaded: false };
    }

    const orphanQuery = [
      `'${escapeDriveQueryValue(paperFolderId)}' in parents`,
      'trashed=false',
      `appProperties has { key='role' and value='paper-rendered-print-pdf' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
      `appProperties has { key='sha256' and value='${localDescriptor.sha256}' }`,
    ].join(' and ');
    const orphanCandidates = dedupeFiles(
      await this.drive.listFiles(orphanQuery, signal, {
        phase: 'rendered-print-pdf-resolution',
        resource: 'rendered-print-pdf',
        documentId,
      }),
    ).sort((first, second) => compareCanonicalStrings(first.id, second.id));
    for (const candidate of orphanCandidates) {
      const candidateDescriptor: RenderedPrintPdfDescriptor = {
        ...localDescriptor,
        fileId: candidate.id,
      };
      try {
        await this.verifyReusableRenderedPrintPdf(
          candidateDescriptor,
          paperFolderId,
          documentId,
          signal,
        );
        return { descriptor: candidateDescriptor, uploaded: false };
      } catch (error) {
        signal.throwIfAborted();
        if (isDriveOperationFailure(error)) throw error;
      }
    }

    onProgress?.({
      documentId,
      phase: 'uploading',
      completed: 0,
      total: 1,
      bytesCompleted: 0,
      bytesTotal: localArtifact.size,
      detail: localArtifact.fileName,
    });
    const uploaded = await this.drive.uploadFile(
      localArtifact.fileName,
      localArtifact.blob,
      {
        parents: [paperFolderId],
        appProperties: {
          ...paperAppProperties('paper-rendered-print-pdf', documentId),
          sha256: localDescriptor.sha256,
          renderedFromDraftHash: localDescriptor.renderedFromDraftHash,
        },
      },
      signal,
      (completed, total) =>
        onProgress?.({
          documentId,
          phase: 'uploading',
          completed: 0,
          total: 1,
          bytesCompleted: completed,
          bytesTotal: total,
          detail: localArtifact.fileName,
        }),
      {
        phase: 'rendered-print-pdf-publication',
        resource: 'rendered-print-pdf',
        documentId,
      },
    );
    const uploadedDescriptor: RenderedPrintPdfDescriptor = {
      ...localDescriptor,
      fileId: uploaded.id,
    };
    assertRenderedPrintPdfMetadata(
      uploaded,
      uploadedDescriptor,
      paperFolderId,
      documentId,
    );
    if (normalizedDriveSha256(uploaded.sha256Checksum) !== localDescriptor.sha256) {
      await this.verifyReusableRenderedPrintPdf(
        uploadedDescriptor,
        paperFolderId,
        documentId,
        signal,
      );
    }
    onProgress?.({
      documentId,
      phase: 'uploading',
      completed: 1,
      total: 1,
      bytesCompleted: localArtifact.size,
      bytesTotal: localArtifact.size,
      detail: localArtifact.fileName,
    });
    return { descriptor: uploadedDescriptor, uploaded: true };
  }

  private async verifyReusableRenderedPrintPdf(
    descriptor: RenderedPrintPdfDescriptor,
    paperFolderId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const metadataBefore = await this.drive.getMetadata(descriptor.fileId, signal, {
      phase: 'rendered-print-pdf-verification',
      resource: 'rendered-print-pdf',
      documentId,
    });
    assertRenderedPrintPdfMetadata(
      metadataBefore,
      descriptor,
      paperFolderId,
      documentId,
    );
    if (normalizedDriveSha256(metadataBefore.sha256Checksum) === descriptor.sha256) {
      return;
    }
    const blob = await this.mediaGate.run(() =>
      this.drive.downloadBlob(descriptor.fileId, signal, {
        phase: 'rendered-print-pdf-verification',
        resource: 'rendered-print-pdf',
        documentId,
      }),
    );
    await assertValidPrintPdfBlob(blob);
    if (
      blob.size !== descriptor.size ||
      (await sha256Hex(blob)) !== descriptor.sha256
    ) {
      throw new PaperManifestIntegrityError(
        'The Drive Print PDF failed integrity verification.',
        documentId,
      );
    }
    const metadataAfter = await this.drive.getMetadata(descriptor.fileId, signal, {
      phase: 'rendered-print-pdf-verification',
      resource: 'rendered-print-pdf',
      documentId,
    });
    assertRenderedPrintPdfMetadata(
      metadataAfter,
      descriptor,
      paperFolderId,
      documentId,
    );
    const beforeEvidence = paperDriveFileEvidence(metadataBefore);
    const afterEvidence = paperDriveFileEvidence(metadataAfter);
    if (
      beforeEvidence &&
      afterEvidence &&
      !samePaperDriveFileEvidence(beforeEvidence, afterEvidence)
    ) {
      throw new PaperRemoteChangedError(documentId);
    }
  }

  private async verifyReusableSourceArtifact(
    descriptor: ExactPaperSourceArtifact,
    knownEvidence: PaperDriveFileEvidence | undefined,
    paperFolderId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<PaperDriveFileEvidence | undefined> {
    const metadataBefore = await this.drive.getMetadata(descriptor.fileId, signal, {
      phase: 'source-document-verification',
      resource: 'source-document',
      documentId,
    });
    assertSourceArtifactMetadata(metadataBefore, descriptor, paperFolderId, documentId);
    const evidenceBefore = paperDriveFileEvidence(metadataBefore);
    if (samePaperDriveFileEvidence(knownEvidence, evidenceBefore)) {
      return evidenceBefore;
    }

    const blob = await this.mediaGate.run(() =>
      this.drive.downloadBlob(descriptor.fileId, signal, {
        phase: 'source-document-verification',
        resource: 'source-document',
        documentId,
      }),
    );
    if (
      blob.size !== descriptor.size ||
      (await sha256Hex(blob)) !== descriptor.sha256
    ) {
      throw new PaperManifestIntegrityError(
        'The Drive source document failed integrity verification.',
        documentId,
      );
    }
    const metadataAfter = await this.drive.getMetadata(descriptor.fileId, signal, {
      phase: 'source-document-verification',
      resource: 'source-document',
      documentId,
    });
    assertSourceArtifactMetadata(metadataAfter, descriptor, paperFolderId, documentId);
    const evidenceAfter = paperDriveFileEvidence(metadataAfter);
    if (
      evidenceBefore &&
      evidenceAfter &&
      !samePaperDriveFileEvidence(evidenceBefore, evidenceAfter)
    ) {
      throw new PaperRemoteChangedError(documentId);
    }
    return evidenceAfter;
  }

  private async publishManifest(
    manifest: PaperCloudManifest,
    dataFolderId: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const text = stableStringify(manifest);
    const uploaded = await this.drive.uploadFile(
      manifestGenerationName(manifest.generation.id),
      new Blob([text], { type: 'application/json' }),
      {
        parents: [dataFolderId],
        appProperties: {
          ...paperAppProperties(
            'paper-manifest-generation',
            manifest.documentId,
            manifest.syncLayoutVersion,
          ),
          manifestStorage: manifest.manifestStorage,
          generationId: manifest.generation.id,
        },
      },
      signal,
      undefined,
      {
        phase: 'manifest-publication',
        resource: 'manifest',
        documentId: manifest.documentId,
      },
    );
    const [verifiedText, metadata] = await Promise.all([
      this.drive.downloadText(uploaded.id, signal, {
        phase: 'post-publish-verification',
        resource: 'post-publish-verification',
        documentId: manifest.documentId,
      }),
      this.drive.getMetadata(uploaded.id, signal, {
        phase: 'post-publish-verification',
        resource: 'post-publish-verification',
        documentId: manifest.documentId,
      }),
    ]);
    if (
      verifiedText !== text ||
      !isPaperManifestFile(metadata, dataFolderId, manifest.documentId) ||
      metadata.name !== manifestGenerationName(manifest.generation.id) ||
      metadata.appProperties?.generationId !== manifest.generation.id
    ) {
      throw new PaperManifestIntegrityError(
        'Google Drive manifest-last verification failed.',
        manifest.documentId,
      );
    }
    const parsed = parsePaperCloudManifest(verifiedText);
    if (
      !(await verifyPaperManifestGeneration(parsed)) ||
      parsed.generation.id !== manifest.generation.id
    ) {
      throw new PaperManifestIntegrityError(
        'Google Drive did not retain the immutable paper manifest.',
        manifest.documentId,
      );
    }
    if (hasImmutableDriveEvidence(metadata)) {
      this.verifiedManifestCache.set(metadata.id, { file: metadata, manifest: parsed });
    }
    return metadata;
  }

  private async verifyLegacyCleanupActivation(
    entries: readonly LegacyDriveTreeEntry[],
    papers: readonly PaperCloudSummary[],
    signal: AbortSignal,
  ): Promise<VerifiedLegacyCleanupActivation | null> {
    const candidates = entries
      .map(({ file }) => file)
      .filter((file) => isLegacyCleanupActivationMetadata(file, this.rootFolderId));
    if (candidates.length !== 1) return null;
    try {
      const activationFile = candidates[0];
      const text = await this.drive.downloadText(activationFile.id, signal);
      const expectedHash = activationFile.appProperties!.sha256!;
      if ((await sha256Hex(text)) !== expectedHash) return null;
      const activation = parsePaperLayoutActivation(text);
      if (
        !activation ||
        stableStringify(activation) !== text ||
        activation.rootFolderId !== this.rootFolderId
      ) {
        return null;
      }
      const paperByDocumentId = new Map(
        papers.map((paper) => [paper.documentId, paper]),
      );
      const migratedManifests = new Map<string, PaperCloudManifest>();
      const verifiedFolderIds = new Set<string>();
      for (const [documentId, generationId] of Object.entries(
        activation.paperGenerations,
      ).sort(([first], [second]) => compareCanonicalStrings(first, second))) {
        const summary = paperByDocumentId.get(documentId);
        if (
          !summary ||
          summary.issue ||
          !activation.paperFolderIds.includes(summary.paperFolderId)
        ) {
          return null;
        }
        const folder = entries.find(
          ({ file }) => file.id === summary.paperFolderId,
        )?.file;
        if (!folder || !isPaperFolder(folder, this.rootFolderId, documentId))
          return null;
        const resolved = await this.resolvePaperFolder(folder, signal, false);
        const migrated = resolved.generations.find(
          ({ manifest }) => manifest.generation.id === generationId,
        );
        if (
          !migrated ||
          !resolved.heads.every((head) =>
            generationDescendsFrom(
              head.manifest.generation.id,
              generationId,
              resolved.generations,
            ),
          )
        ) {
          return null;
        }
        const [, , migratedConflicts] = await Promise.all([
          this.downloadPayload(
            migrated.manifest.state,
            'document-state',
            documentId,
            signal,
          ),
          this.downloadPayload(
            migrated.manifest.productivity,
            'productivity-data',
            documentId,
            signal,
          ),
          this.downloadConflictPayload(
            migrated.manifest.conflictJournal,
            documentId,
            signal,
          ),
        ]);
        if (
          !sameStringSet(
            migratedConflicts.conflicts.map(({ id }) => id),
            migrated.manifest.conflictIds,
          )
        ) {
          return null;
        }
        const migratedSource = sourceArtifactFromManifest(migrated.manifest);
        if (migratedSource) {
          const source = migratedSource;
          const metadata = await this.drive.getMetadata(source.fileId, signal);
          assertSourceArtifactMetadata(metadata, source, folder.id, documentId);
          const blob = await this.drive.downloadBlob(source.fileId, signal);
          if (blob.size !== source.size || (await sha256Hex(blob)) !== source.sha256) {
            return null;
          }
        }
        verifiedFolderIds.add(folder.id);
        migratedManifests.set(documentId, migrated.manifest);
      }
      if (
        migratedManifests.size === 0 ||
        !sameStringSet([...verifiedFolderIds], activation.paperFolderIds)
      ) {
        return null;
      }
      return {
        legacyTopLevelIds: new Set(activation.legacyManagedFileIds),
        migratedManifests,
      };
    } catch (error) {
      if (isDriveOperationFailure(error)) throw error;
      return null;
    }
  }

  private async findSupersededLegacyFiles(
    entries: readonly LegacyDriveTreeEntry[],
    activation: VerifiedLegacyCleanupActivation,
    signal: AbortSignal,
  ): Promise<string[]> {
    const authorized = new Set<string>();
    const files = entries.map(({ file }) => file);
    const documentsFolders = new Set(
      files
        .filter(
          (file) =>
            activation.legacyTopLevelIds.has(file.id) &&
            isLegacyRoleMetadata(file, 'documents') &&
            file.mimeType === FOLDER_MIME &&
            file.name === 'documents' &&
            hasExactParent(file, this.rootFolderId),
        )
        .map(({ id }) => id),
    );
    const documentFolders = new Map<string, string>();
    for (const file of files) {
      const documentId = file.appProperties?.documentId;
      if (
        documentId &&
        file.mimeType === FOLDER_MIME &&
        file.name === legacyDocumentFolderName(documentId) &&
        isLegacyRoleMetadata(file, 'document') &&
        file.parents?.length === 1 &&
        documentsFolders.has(file.parents[0]) &&
        activation.migratedManifests.has(documentId)
      ) {
        documentFolders.set(file.id, documentId);
      }
    }

    for (const file of files) {
      signal.throwIfAborted();
      const role = file.appProperties?.role;
      if (
        activation.legacyTopLevelIds.has(file.id) &&
        hasExactParent(file, this.rootFolderId)
      ) {
        if (role === 'manifest-generation' && isLegacyRoleMetadata(file, role)) {
          try {
            const manifest = parseCloudManifest(
              await this.drive.downloadText(file.id, signal),
            );
            if (
              isImmutableCloudManifest(manifest) &&
              (await verifyCloudManifestGeneration(manifest)) &&
              manifest.generation.id === file.appProperties?.generationId
            ) {
              authorized.add(file.id);
            }
          } catch (error) {
            if (isDriveOperationFailure(error)) throw error;
          }
        } else if (
          (role === 'library' || role === 'ai-settings') &&
          isLegacyRoleMetadata(file, role)
        ) {
          const hash = file.appProperties?.sha256;
          const baseName = role === 'library' ? 'library' : 'ai-settings';
          if (
            hash &&
            file.name === `${baseName}-${hash.slice(0, 16)}.json` &&
            (await sha256Hex(await this.drive.downloadBlob(file.id, signal))) === hash
          ) {
            authorized.add(file.id);
          }
        }
      }

      const parentId = file.parents?.length === 1 ? file.parents[0] : undefined;
      const documentId = parentId ? documentFolders.get(parentId) : undefined;
      const migrated = documentId
        ? activation.migratedManifests.get(documentId)
        : undefined;
      if (!documentId || !migrated || !role || !isLegacyRoleMetadata(file, role)) {
        continue;
      }
      const metadataDocumentId = file.appProperties?.documentId;
      if (metadataDocumentId !== undefined && metadataDocumentId !== documentId)
        continue;
      const expectedHash =
        role === 'state'
          ? migrated.state.sha256
          : role === 'productivity'
            ? migrated.productivity.sha256
            : role === 'original-pdf'
              ? sourceArtifactFromManifest(migrated)?.documentType === 'pdf'
                ? sourceArtifactFromManifest(migrated)?.sha256
                : undefined
              : undefined;
      if (!expectedHash) continue;
      const blob = await this.drive.downloadBlob(file.id, signal);
      if ((await sha256Hex(blob)) === expectedHash) authorized.add(file.id);
    }
    return [...authorized].sort(compareCanonicalStrings);
  }

  private async verifyLegacyCleanupAncestry(
    fileId: string,
    confirmed: LegacyDriveInventory,
    signal: AbortSignal,
  ): Promise<void> {
    const confirmedById = new Map(confirmed.items.map((item) => [item.id, item]));
    const visited = new Set<string>();
    let currentId = fileId;
    while (currentId !== this.rootFolderId) {
      if (visited.has(currentId) || visited.size > confirmed.items.length) {
        throw new LegacyDriveCleanupRefusedError(
          'Legacy cleanup ancestry is ambiguous. Remaining data was preserved.',
        );
      }
      visited.add(currentId);
      const expected = confirmedById.get(currentId);
      if (
        !expected ||
        expected.classification !== 'recognized-legacy' ||
        (currentId === fileId &&
          (!expected.cleanupEligible || expected.kind !== 'file'))
      ) {
        throw new LegacyDriveCleanupRefusedError(
          'Legacy cleanup ancestry no longer matches the confirmed inventory.',
        );
      }
      const current = await this.drive.getMetadata(currentId, signal, {
        phase: 'legacy-cleanup-ancestry-preflight',
        resource: 'legacy-cleanup',
      });
      if (
        current.trashed ||
        (await driveMetadataEvidenceHash(current)) !== expected.evidenceHash ||
        current.parents?.length !== 1
      ) {
        throw new LegacyDriveCleanupRefusedError(
          'A legacy item or its parent changed after confirmation. Remaining data was preserved.',
        );
      }
      currentId = current.parents[0];
    }
    const root = await this.drive.getMetadata(this.rootFolderId, signal, {
      phase: 'legacy-cleanup-ancestry-preflight',
      resource: 'root',
    });
    if (root.id !== this.rootFolderId || !isPaperV3RootMetadata(root)) {
      throw new LegacyDriveCleanupRefusedError(
        'The selected Drive root changed after confirmation. Remaining data was preserved.',
      );
    }
  }

  private async listLegacyInventoryTree(
    signal: AbortSignal,
  ): Promise<LegacyDriveTreeEntry[]> {
    const entries = new Map<string, LegacyDriveTreeEntry>();
    const queued = [{ folderId: this.rootFolderId, depth: 0 }];
    const visitedFolders = new Set<string>();
    while (queued.length > 0) {
      signal.throwIfAborted();
      const next = queued.shift()!;
      if (visitedFolders.has(next.folderId)) continue;
      visitedFolders.add(next.folderId);
      for (const file of await this.listChildrenForLegacyInventory(
        next.folderId,
        signal,
      )) {
        const depth = next.depth + 1;
        const existing = entries.get(file.id);
        if (!existing || depth < existing.depth) entries.set(file.id, { file, depth });
        if (file.mimeType === FOLDER_MIME && !visitedFolders.has(file.id)) {
          queued.push({ folderId: file.id, depth });
        }
      }
    }
    return [...entries.values()];
  }

  private async listChildrenForLegacyInventory(
    parentId: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata[]> {
    const listed = dedupeFiles(
      await this.drive.listFiles(
        `'${escapeDriveQueryValue(parentId)}' in parents and trashed=false`,
        signal,
        { phase: 'legacy-inventory', resource: 'file-list' },
      ),
    );
    const children: DriveFileMetadata[] = [];
    for (const candidate of listed) {
      let current: DriveFileMetadata;
      try {
        current = await this.drive.getMetadata(candidate.id, signal, {
          phase: 'legacy-inventory',
          resource: 'file-metadata',
        });
      } catch (error) {
        if (error instanceof DriveRequestError && error.status === 404) continue;
        throw error;
      }
      if (current.trashed || !current.parents?.includes(parentId)) continue;
      children.push(current);
    }
    return children.sort((first, second) =>
      compareCanonicalStrings(first.id, second.id),
    );
  }

  private async verifyCurrentPaperPayloads(signal: AbortSignal): Promise<void> {
    await this.assertActiveRoot(signal);
    const papers = await this.discover(undefined, signal, {
      layoutValidated: true,
      reuseVerifiedManifests: false,
    });
    if (papers.length === 0) {
      throw new PaperManifestIntegrityError(
        'No current paper data exists to prove legacy Drive data is obsolete.',
      );
    }
    const failed = papers.find((paper) => paper.issue);
    if (failed) {
      throw new PaperManifestIntegrityError(
        'Current paper data could not be verified before legacy cleanup.',
        failed.documentId,
      );
    }
    await mapWithConcurrency(papers, PAPER_METADATA_CONCURRENCY, async (paper) => {
      const resolved = await this.resolvePaperFromSummary(paper, signal, true, false);
      if (resolved.heads.length === 0) {
        throw new PaperManifestIntegrityError(
          'A current paper has no verified immutable head.',
          paper.documentId,
        );
      }
    });
  }

  private listChildren(
    parentId: string,
    signal: AbortSignal,
    resource: 'root' | 'paper-folder' | 'data-folder',
  ): Promise<DriveFileMetadata[]> {
    return this.drive.listFiles(
      `'${escapeDriveQueryValue(parentId)}' in parents and trashed=false`,
      signal,
      { phase: 'layout-validation', resource },
    );
  }
}

function derivePaperHeads(
  generations: readonly LoadedPaperGeneration[],
  documentId: string,
): LoadedPaperGeneration[] {
  if (generations.length === 0) return [];
  const byId = new Map<string, LoadedPaperGeneration>();
  for (const generation of generations) {
    const id = generation.manifest.generation.id;
    const existing = byId.get(id);
    if (
      existing &&
      stableStringify(existing.manifest) !== stableStringify(generation.manifest)
    ) {
      throw new PaperManifestIntegrityError(
        'Conflicting immutable paper generation identities were found.',
        documentId,
      );
    }
    if (!existing || generation.file.id < existing.file.id) byId.set(id, generation);
  }
  for (const generation of byId.values()) {
    for (const parentId of generation.manifest.generation.parents) {
      const parent = byId.get(parentId);
      if (!parent) {
        throw new PaperManifestIntegrityError(
          'A paper generation references a missing parent.',
          documentId,
        );
      }
      if (!paperManifestPreservesParent(generation.manifest, parent.manifest)) {
        throw new PaperManifestIntegrityError(
          'A paper generation does not preserve its parent evidence.',
          documentId,
        );
      }
    }
  }
  assertAcyclic(byId, documentId);
  const parents = new Set(
    [...byId.values()].flatMap(({ manifest }) => manifest.generation.parents),
  );
  return [...byId.values()]
    .filter(({ manifest }) => !parents.has(manifest.generation.id))
    .sort((first, second) =>
      compareCanonicalStrings(
        first.manifest.generation.id,
        second.manifest.generation.id,
      ),
    );
}

function generationDescendsFrom(
  generationId: string,
  ancestorId: string,
  generations: readonly LoadedPaperGeneration[],
): boolean {
  const parents = new Map(
    generations.map(({ manifest }) => [
      manifest.generation.id,
      manifest.generation.parents,
    ]),
  );
  const pending = [generationId];
  const visited = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (next === ancestorId) return true;
    if (visited.has(next)) continue;
    visited.add(next);
    pending.push(...(parents.get(next) ?? []));
  }
  return false;
}

function foldLoadedHeads(heads: readonly LoadedPaperGeneration[]): {
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
} {
  if (heads.length === 0 || heads.some((head) => !head.snapshot || !head.conflicts)) {
    throw new Error('Paper payloads must be loaded before reconciliation.');
  }
  const ordered = [...heads].sort((first, second) =>
    compareCanonicalStrings(
      first.manifest.generation.id,
      second.manifest.generation.id,
    ),
  );
  let snapshot = ordered[0].snapshot!;
  let conflicts = mergeConflicts(ordered[0].conflicts!);
  for (const head of ordered.slice(1)) {
    try {
      const merged = mergeSyncSnapshots(
        snapshot,
        head.snapshot!,
        {},
        deterministicSnapshotTime(snapshot, head.snapshot!),
      );
      snapshot = merged.snapshot;
      conflicts = mergeConflicts(conflicts, head.conflicts!, merged.conflicts);
    } catch (error) {
      if (error instanceof Error && /Original PDF conflict/u.test(error.message)) {
        throw new PaperSourcePdfConflictError(head.manifest.documentId);
      }
      throw error;
    }
  }
  return { snapshot, conflicts };
}

function paperManifestPreservesParent(
  child: PaperCloudManifest,
  parent: PaperCloudManifest,
): boolean {
  const parentSource = sourceArtifactFromManifest(parent);
  const childSource = sourceArtifactFromManifest(child);
  if (
    child.documentId !== parent.documentId ||
    child.paperFolderId !== parent.paperFolderId ||
    child.dataFolderId !== parent.dataFolderId ||
    (parentSource &&
      (!childSource || !sourceArtifactsHaveSameIdentity(parentSource, childSource)))
  ) {
    return false;
  }
  const childConflicts = new Set(child.conflictIds);
  const childRecovery = new Set((child.recoveryEvidence ?? []).map(stableStringify));
  return (
    parent.conflictIds.every((conflictId) => childConflicts.has(conflictId)) &&
    (parent.recoveryEvidence ?? []).every((evidence) =>
      childRecovery.has(stableStringify(evidence)),
    )
  );
}

function assertAcyclic(
  byId: ReadonlyMap<string, LoadedPaperGeneration>,
  documentId: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new PaperManifestIntegrityError(
        'A paper generation ancestry cycle was found.',
        documentId,
      );
    }
    visiting.add(id);
    for (const parent of byId.get(id)?.manifest.generation.parents ?? []) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function failedPaperSummary(
  folder: DriveFileMetadata,
  documentId: string,
  state: PaperSyncState | undefined,
  error: unknown,
): PaperCloudSummary {
  const repositoryError = error instanceof PaperRepositoryError ? error : null;
  return {
    documentId,
    displayName:
      typeof folder?.name === 'string' && folder.name.trim()
        ? folder.name.trim().slice(0, 240)
        : (state?.displayName ?? 'Unavailable paper'),
    deleted: false,
    paperFolderId: folder?.id ?? 'unavailable',
    headIds: [],
    headSetId: 'unavailable',
    localAvailability: state?.availability ?? 'cloud-only',
    status: 'needs-attention',
    issue: {
      code: repositoryError?.code ?? 'paper-integrity-failed',
      message:
        repositoryError instanceof AmbiguousManagedPaperError
          ? 'More than one managed Drive folder claims this paper identity.'
          : 'Drive data for this paper needs verification.',
    },
  };
}

async function removedPaperSummary(
  presence: ResolvedPaperPresence,
  state: PaperSyncState | undefined,
  physicalFolders: readonly DriveFileMetadata[],
  ambiguousCleanup: boolean,
): Promise<PaperCloudSummary> {
  const paperFolderId =
    presence.paperFolderId ??
    [...presence.heads].sort((first, second) =>
      compareCanonicalStrings(first.generation.id, second.generation.id),
    )[0].paperFolderId;
  const hasLocalCopy = Boolean(state && state.availability !== 'cloud-only');
  return {
    documentId: presence.documentId,
    displayName: state?.displayName ?? presence.displayName,
    deleted: false,
    paperFolderId,
    headIds: [],
    headSetId: await headSetId(presence.headIds),
    managedFileIds: [
      ...(presence.managedFileIds ?? []),
      ...physicalFolders.map(({ id }) => id),
    ].filter((id, index, values) => values.indexOf(id) === index),
    localAvailability: hasLocalCopy ? 'local-only' : 'cloud-only',
    status: ambiguousCleanup
      ? 'needs-attention'
      : hasLocalCopy
        ? 'local-only'
        : 'cloud-only',
    presenceState: 'removed',
    presenceHeadIds: [...presence.headIds],
    cleanupPending: physicalFolders.length > 0,
    ...(ambiguousCleanup
      ? {
          issue: {
            code: 'paper-presence-invalid',
            message: 'The paper remains removed, but Drive cleanup needs verification.',
          },
        }
      : {}),
  };
}

function withPresence(
  result: PaperPublishResult,
  presence: ResolvedPaperPresence,
): PaperPublishResult {
  if (
    presence.state !== 'present' ||
    presence.paperFolderId !== result.cloud.paperFolderId
  ) {
    throw new PaperRepositoryError(
      'paper-presence-invalid',
      'The published paper package is not authorized by Drive presence.',
    );
  }
  return {
    ...result,
    cloud: {
      ...result.cloud,
      presenceState: 'present',
      presenceHeadIds: [...presence.headIds],
      cleanupPending: false,
      managedFileIds: [
        ...(result.cloud.managedFileIds ?? []),
        ...(presence.managedFileIds ?? []),
      ].filter((id, index, values) => values.indexOf(id) === index),
    },
  };
}

function presenceFolderPlaceholder(presence: ResolvedPaperPresence): DriveFileMetadata {
  return {
    id:
      presence.paperFolderId ??
      [...presence.heads].sort((first, second) =>
        compareCanonicalStrings(first.generation.id, second.generation.id),
      )[0].paperFolderId,
    name: presence.displayName,
    mimeType: FOLDER_MIME,
  };
}

function groupByDocumentId(
  files: readonly DriveFileMetadata[],
): Map<string, DriveFileMetadata[]> {
  const grouped = new Map<string, DriveFileMetadata[]>();
  for (const file of files) {
    const documentId = file.appProperties?.documentId;
    if (!documentId) continue;
    grouped.set(documentId, [...(grouped.get(documentId) ?? []), file]);
  }
  return grouped;
}

function isPaperFolder(
  file: DriveFileMetadata,
  rootFolderId: string,
  documentId?: string,
): boolean {
  return (
    file.mimeType === FOLDER_MIME &&
    !file.trashed &&
    file.parents?.length === 1 &&
    file.parents[0] === rootFolderId &&
    isPaperRole(file, 'paper-folder', documentId)
  );
}

/** Identity check used only with an exact presence-authorized file ID. */
function isOwnedPaperFolderIdentity(
  file: DriveFileMetadata,
  rootFolderId: string,
  documentId: string,
): boolean {
  return (
    file.id !== rootFolderId &&
    file.mimeType === FOLDER_MIME &&
    file.ownedByMe === true &&
    isPaperRole(file, 'paper-folder', documentId)
  );
}

function isPaperDataFolder(
  file: DriveFileMetadata,
  paperFolderId: string,
  documentId: string,
): boolean {
  return (
    file.name === PAPER_DATA_NAME &&
    file.mimeType === FOLDER_MIME &&
    !file.trashed &&
    file.parents?.length === 1 &&
    file.parents[0] === paperFolderId &&
    isPaperRole(file, 'paper-data', documentId)
  );
}

function isPaperManifestFile(
  file: DriveFileMetadata,
  dataFolderId: string,
  documentId: string,
): boolean {
  const layoutVersion = paperPackageLayoutVersion(file);
  const expectedManifestStorage =
    layoutVersion === LEGACY_PAPER_PACKAGE_LAYOUT_VERSION
      ? LEGACY_PAPER_MANIFEST_STORAGE
      : layoutVersion === PAPER_PACKAGE_LAYOUT_VERSION
        ? PAPER_MANIFEST_STORAGE
        : undefined;
  return (
    file.mimeType === 'application/json' &&
    !file.trashed &&
    file.parents?.length === 1 &&
    file.parents[0] === dataFolderId &&
    isPaperRole(file, 'paper-manifest-generation', documentId) &&
    expectedManifestStorage !== undefined &&
    file.appProperties?.manifestStorage === expectedManifestStorage &&
    typeof file.appProperties.generationId === 'string'
  );
}

function isPaperRole(
  file: DriveFileMetadata,
  role: string,
  documentId?: string,
): boolean {
  const layoutVersion = paperPackageLayoutVersion(file);
  return (
    file.appProperties?.application === '39Note' &&
    (layoutVersion === LEGACY_PAPER_PACKAGE_LAYOUT_VERSION ||
      layoutVersion === PAPER_PACKAGE_LAYOUT_VERSION) &&
    file.appProperties.paperProtocolVersion === String(PAPER_SYNC_PROTOCOL_VERSION) &&
    file.appProperties.role === role &&
    (!documentId || file.appProperties.documentId === documentId)
  );
}

function paperPackageLayoutVersion(file: DriveFileMetadata): number | undefined {
  const raw = file.appProperties?.layoutVersion;
  return raw && /^\d+$/u.test(raw) ? Number(raw) : undefined;
}

function isManagedRole(file: DriveFileMetadata, roles: ReadonlySet<string>): boolean {
  return (
    file.appProperties?.application === '39Note' &&
    typeof file.appProperties.role === 'string' &&
    roles.has(file.appProperties.role)
  );
}

function paperAppProperties(
  role: string,
  documentId: string,
  layoutVersion:
    | typeof LEGACY_PAPER_PACKAGE_LAYOUT_VERSION
    | typeof PAPER_PACKAGE_LAYOUT_VERSION = PAPER_PACKAGE_LAYOUT_VERSION,
): Record<string, string> {
  return {
    application: '39Note',
    syncSchema: '1',
    layoutVersion: String(layoutVersion),
    paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
    role,
    documentId,
  };
}

function mergeConflicts(...journals: readonly SyncConflict[][]): SyncConflict[] {
  return [
    ...new Map(
      journals.flat().map((conflict) => [stableStringify(conflict), conflict]),
    ).values(),
  ].sort((first, second) =>
    compareCanonicalStrings(stableStringify(first), stableStringify(second)),
  );
}

function sameConflictIds(
  first: readonly string[],
  second: readonly SyncConflict[],
): boolean {
  return sameStringSet(
    first,
    second.map((conflict) => conflict.id),
  );
}

function snapshotContent(snapshot: SyncSnapshot): string {
  return stableStringify({
    app: snapshot.app,
    syncSchemaVersion: snapshot.syncSchemaVersion,
    entities: [...snapshot.entities].sort((a, b) =>
      compareCanonicalStrings(a.key, b.key),
    ),
    tombstones: [...snapshot.tombstones].sort((a, b) =>
      compareCanonicalStrings(a.key, b.key),
    ),
    // Source identity is validated independently through the normalized
    // sourceArtifact model. Layout 2 projected it into `pdfs`, whereas layout
    // 3 deliberately does not; including that compatibility slot here would
    // turn an otherwise identical layout-3 package into a false edit.
  });
}

function deterministicSnapshotTime(...snapshots: readonly SyncSnapshot[]): number {
  return Math.max(
    0,
    ...snapshots.flatMap((snapshot) => [
      snapshot.generatedAt,
      ...snapshot.entities.map((entity) => entity.version.updatedAt),
      ...snapshot.tombstones.map((tombstone) => tombstone.deletedAt),
    ]),
  );
}

function snapshotIsDeleted(snapshot: SyncSnapshot, documentId: string): boolean {
  const live = snapshot.entities.some(
    (entity) => entity.kind === 'document' && entity.id === documentId,
  );
  if (live) return false;
  return snapshot.tombstones.some(
    (tombstone) => tombstone.kind === 'document' && tombstone.id === documentId,
  );
}

function withoutExactDriveIdentity(
  descriptor: SyncSourceArtifactDescriptor,
): SyncSourceArtifactDescriptor {
  const identity = { ...descriptor };
  delete identity.fileId;
  delete identity.driveRole;
  return identity;
}

function sanitizeWriter(
  writer: LocalPaperPackage['writer'],
): LocalPaperPackage['writer'] {
  if (!writer.deviceId || writer.deviceId.length > 256) {
    throw new Error('Invalid paper writer identity.');
  }
  const label = writer.deviceLabel?.trim().slice(0, 80);
  return {
    deviceId: writer.deviceId,
    ...(label ? { deviceLabel: label } : {}),
  };
}

function normalizePresentationName(value: string): string {
  const normalized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f;
    })
    .join('')
    .replace(/[\\/]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '')
    .slice(0, 180);
  return normalized || 'Untitled Paper';
}

/** Cosmetic Drive folder name; document/source identity never depends on it. */
export function normalizePaperFolderName(value: string): string {
  const presentationName = normalizePresentationName(value);
  if (!/\.pdf$/iu.test(presentationName)) return presentationName;
  return normalizePresentationName(presentationName.slice(0, -4));
}

function payloadGenerationName(baseName: string, sha256: string): string {
  const extension = baseName.endsWith('.json') ? '.json' : '';
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  return `${stem}-${sha256.slice(0, 16)}${extension}`;
}

function manifestGenerationName(generationId: string): string {
  return `paper-manifest-v${PAPER_SYNC_PROTOCOL_VERSION}-${generationId}.json`;
}

async function headSetId(headIds: readonly string[]): Promise<string> {
  const sorted = [...headIds].sort(compareCanonicalStrings);
  return sorted.length === 1
    ? sorted[0]
    : sha256Hex(stableStringify({ paperHeads: sorted }));
}

function normalizeMigrationProof(
  proof: PaperLayoutMigrationProof,
): Readonly<PaperLayoutMigrationProof> {
  if (
    proof.recordId !== 'layout' ||
    (proof.phase !== 'publishing-papers' && proof.phase !== 'activating-layout') ||
    !isSafeDriveId(proof.rootFolderId)
  ) {
    throw new PaperLayoutMigrationProofError();
  }
  const normalizeIdentities = (
    values: readonly string[],
    allowEmpty: boolean,
  ): readonly string[] => {
    if (
      (!allowEmpty && values.length === 0) ||
      values.some(
        (value) =>
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > 512 ||
          hasControlCharacters(value),
      ) ||
      new Set(values).size !== values.length
    ) {
      throw new PaperLayoutMigrationProofError();
    }
    return Object.freeze([...values].sort(compareCanonicalStrings));
  };
  const targetDocumentIds = normalizeIdentities(proof.targetDocumentIds, false);
  const publishedDocumentIds = normalizeIdentities(proof.publishedDocumentIds, true);
  const verifiedLegacyFileIds = normalizeIdentities(proof.verifiedLegacyFileIds, true);
  if (
    typeof proof.publishedGenerationIds !== 'object' ||
    proof.publishedGenerationIds === null ||
    Array.isArray(proof.publishedGenerationIds)
  ) {
    throw new PaperLayoutMigrationProofError();
  }
  const publishedGenerationEntries = Object.entries(proof.publishedGenerationIds).sort(
    ([first], [second]) => compareCanonicalStrings(first, second),
  );
  if (
    publishedGenerationEntries.some(
      ([documentId, generationId]) =>
        !publishedDocumentIds.includes(documentId) ||
        !/^[a-f0-9]{64}$/u.test(generationId),
    ) ||
    !sameStringSet(
      publishedGenerationEntries.map(([documentId]) => documentId),
      publishedDocumentIds,
    )
  ) {
    throw new PaperLayoutMigrationProofError();
  }
  const publishedGenerationIds = Object.freeze(
    Object.fromEntries(publishedGenerationEntries),
  );
  if (
    publishedDocumentIds.some((documentId) => !targetDocumentIds.includes(documentId))
  ) {
    throw new PaperLayoutMigrationProofError();
  }
  return Object.freeze({
    recordId: 'layout',
    rootFolderId: proof.rootFolderId,
    phase: proof.phase,
    targetDocumentIds,
    publishedDocumentIds,
    publishedGenerationIds,
    verifiedLegacyFileIds,
  });
}

function isDriveOperationFailure(error: unknown): boolean {
  return (
    error instanceof DriveAuthorizationError ||
    error instanceof DriveNetworkError ||
    error instanceof DriveRequestError ||
    error instanceof GoogleReauthorizationRequiredError ||
    error instanceof SyncBackendUnavailableError ||
    error instanceof SyncServiceRateLimitedError ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

function isInaccessibleDriveIdentity(error: unknown): boolean {
  return (
    error instanceof DriveRequestError && (error.status === 403 || error.status === 404)
  );
}

function shouldFallbackAfterRestoreVerification(error: unknown): boolean {
  if (error instanceof PaperSourcePdfConflictError) return false;
  if (error instanceof PaperRemoteChangedError) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof DriveRequestError) return isInaccessibleDriveIdentity(error);
  if (
    error instanceof DriveAuthorizationError ||
    error instanceof DriveNetworkError ||
    error instanceof GoogleReauthorizationRequiredError ||
    error instanceof SyncBackendUnavailableError ||
    error instanceof SyncServiceRateLimitedError
  ) {
    return false;
  }
  return true;
}

function sameLegacyProtectionOptions(
  first: LegacyDriveHousekeepingOptions,
  second: LegacyDriveHousekeepingOptions,
): boolean {
  return (
    first.migrationInProgress === second.migrationInProgress &&
    sameStringSet(
      first.protectedLegacyFileIds ?? [],
      second.protectedLegacyFileIds ?? [],
    )
  );
}

function assertInventoryMatchesConfirmedScope(
  current: LegacyDriveInventory,
  confirmed: LegacyDriveInventory,
  trashedIds: readonly string[],
): void {
  if (current.rootFolderId !== confirmed.rootFolderId || current.cleanupBlockedReason) {
    throw new LegacyDriveCleanupRefusedError(
      current.cleanupBlockedReason ??
        'The selected Drive root changed during cleanup. Remaining data was preserved.',
    );
  }
  const trashed = new Set(trashedIds);
  const expectedRemaining = new Map(
    confirmed.items.filter(({ id }) => !trashed.has(id)).map((item) => [item.id, item]),
  );
  if (current.items.length !== expectedRemaining.size) {
    throw new LegacyDriveCleanupRefusedError(
      'Drive contents changed during cleanup. Newly discovered data was preserved.',
    );
  }
  for (const item of current.items) {
    const expected = expectedRemaining.get(item.id);
    if (
      !expected ||
      item.evidenceHash !== expected.evidenceHash ||
      item.classification !== expected.classification ||
      item.cleanupEligible !== expected.cleanupEligible ||
      item.kind !== expected.kind
    ) {
      throw new LegacyDriveCleanupRefusedError(
        'Drive contents changed during cleanup. Remaining data was preserved.',
      );
    }
  }
  const expectedTargets = confirmed.cleanupTargetIds.filter((id) => !trashed.has(id));
  if (!sameStringSet(current.cleanupTargetIds, expectedTargets)) {
    throw new LegacyDriveCleanupRefusedError(
      'Legacy cleanup scope changed after confirmation. Remaining data was preserved.',
    );
  }
}

function sameStringSet(first: readonly string[], second: readonly string[]): boolean {
  return (
    stableStringify([...new Set(first)].sort(compareCanonicalStrings)) ===
    stableStringify([...new Set(second)].sort(compareCanonicalStrings))
  );
}

function normalizedDriveSha256(value: string | undefined): string | undefined {
  return value && /^[a-f\d]{64}$/iu.test(value) ? value.toLowerCase() : undefined;
}

function dedupeFiles(files: readonly DriveFileMetadata[]): DriveFileMetadata[] {
  return [...new Map(files.map((file) => [file.id, file])).values()];
}

function hasImmutableDriveEvidence(file: DriveFileMetadata): boolean {
  return paperDriveFileEvidence(file) !== undefined;
}

function paperDriveFileEvidence(
  file: DriveFileMetadata,
): PaperDriveFileEvidence | undefined {
  if (
    !file.version ||
    !file.md5Checksum ||
    !/^[a-f\d]{32}$/iu.test(file.md5Checksum) ||
    !file.size ||
    !/^\d+$/u.test(file.size)
  ) {
    return undefined;
  }
  return {
    fileId: file.id,
    version: file.version,
    md5Checksum: file.md5Checksum.toLowerCase(),
    size: file.size,
  };
}

function samePaperDriveFileEvidence(
  first: PaperDriveFileEvidence | undefined,
  second: PaperDriveFileEvidence | undefined,
): boolean {
  return Boolean(
    first &&
    second &&
    first.fileId === second.fileId &&
    first.version === second.version &&
    first.md5Checksum === second.md5Checksum &&
    first.size === second.size,
  );
}

function assertSourceArtifactMetadata(
  file: DriveFileMetadata,
  descriptor: ExactPaperSourceArtifact,
  paperFolderId: string,
  documentId: string,
): void {
  if (
    file.id !== descriptor.fileId ||
    file.trashed ||
    file.mimeType !== descriptor.mimeType ||
    file.parents?.length !== 1 ||
    file.parents[0] !== paperFolderId ||
    file.appProperties?.application !== '39Note' ||
    file.appProperties.role !== descriptor.driveRole ||
    file.appProperties.documentId !== documentId ||
    file.appProperties.sha256 !== descriptor.sha256 ||
    (normalizedDriveSha256(file.sha256Checksum) !== undefined &&
      normalizedDriveSha256(file.sha256Checksum) !== descriptor.sha256) ||
    file.size !== String(descriptor.size)
  ) {
    throw new PaperManifestIntegrityError(
      'The Drive source document metadata failed integrity verification.',
      documentId,
    );
  }
}

type RenderedPrintPdfContentDescriptor = Omit<RenderedPrintPdfDescriptor, 'fileId'>;

function renderedPrintPdfDescriptorWithoutFileId(
  artifact: StoredRenderedPrintPdf,
): RenderedPrintPdfContentDescriptor {
  return {
    kind: 'rendered-print-pdf',
    documentId: artifact.documentId,
    fileName: artifact.fileName,
    mimeType: 'application/pdf',
    size: artifact.size,
    sha256: artifact.sha256,
    renderedFromDraftHash: artifact.renderedFromDraftHash,
    createdAt: artifact.createdAt,
  };
}

function selectRenderedPrintPdfDescriptor(
  heads: readonly LoadedPaperGeneration[],
): RenderedPrintPdfDescriptor | undefined {
  const descriptors = [
    ...new Map(
      heads.flatMap(({ manifest }) =>
        manifest.renderedPrintPdf
          ? [
              [
                stableStringify(
                  renderedPrintPdfContentIdentity(manifest.renderedPrintPdf),
                ),
                manifest.renderedPrintPdf,
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  return descriptors.sort((first, second) =>
    compareCanonicalStrings(stableStringify(first), stableStringify(second)),
  )[0];
}

function sameOptionalRenderedPrintPdf(
  first: RenderedPrintPdfDescriptor | undefined,
  second: RenderedPrintPdfDescriptor | undefined,
): boolean {
  return (
    (!first && !second) ||
    Boolean(first && second && sameRenderedPrintPdfContent(first, second))
  );
}

function sameRenderedPrintPdfContent(
  first: RenderedPrintPdfDescriptor | RenderedPrintPdfContentDescriptor,
  second: RenderedPrintPdfDescriptor | RenderedPrintPdfContentDescriptor,
): boolean {
  return (
    stableStringify(renderedPrintPdfContentIdentity(first)) ===
    stableStringify(renderedPrintPdfContentIdentity(second))
  );
}

function renderedPrintPdfContentIdentity(
  value: RenderedPrintPdfDescriptor | RenderedPrintPdfContentDescriptor,
) {
  return {
    kind: value.kind,
    documentId: value.documentId,
    fileName: value.fileName,
    mimeType: value.mimeType,
    size: value.size,
    sha256: value.sha256,
    renderedFromDraftHash: value.renderedFromDraftHash,
  };
}

function assertRenderedPrintPdfMetadata(
  file: DriveFileMetadata,
  descriptor: RenderedPrintPdfDescriptor,
  paperFolderId: string,
  documentId: string,
): void {
  if (
    file.id !== descriptor.fileId ||
    file.trashed ||
    file.name !== descriptor.fileName ||
    file.mimeType !== 'application/pdf' ||
    file.parents?.length !== 1 ||
    file.parents[0] !== paperFolderId ||
    !isPaperRole(file, 'paper-rendered-print-pdf', documentId) ||
    file.appProperties?.sha256 !== descriptor.sha256 ||
    file.appProperties.renderedFromDraftHash !== descriptor.renderedFromDraftHash ||
    (normalizedDriveSha256(file.sha256Checksum) !== undefined &&
      normalizedDriveSha256(file.sha256Checksum) !== descriptor.sha256) ||
    file.size !== String(descriptor.size)
  ) {
    throw new PaperManifestIntegrityError(
      'The Drive Print PDF metadata failed integrity verification.',
      documentId,
    );
  }
}

function sameImmutableDriveEvidence(
  cached: DriveFileMetadata,
  current: DriveFileMetadata,
): boolean {
  return (
    hasImmutableDriveEvidence(cached) &&
    hasImmutableDriveEvidence(current) &&
    cached.id === current.id &&
    cached.version === current.version &&
    cached.md5Checksum === current.md5Checksum &&
    cached.size === current.size &&
    cached.name === current.name &&
    cached.mimeType === current.mimeType &&
    stableStringify(cached.parents ?? []) === stableStringify(current.parents ?? []) &&
    stableStringify(cached.appProperties ?? {}) ===
      stableStringify(current.appProperties ?? {}) &&
    current.trashed !== true
  );
}

function isLegacyCleanupActivationMetadata(
  file: DriveFileMetadata,
  rootFolderId: string,
): boolean {
  const hash = file.appProperties?.sha256;
  return Boolean(
    file.ownedByMe === true &&
    !file.trashed &&
    file.mimeType === 'application/json' &&
    hasExactParent(file, rootFolderId) &&
    isPaperRole(file, 'paper-layout-activation', 'layout') &&
    file.appProperties?.layoutVersion === String(LEGACY_PAPER_PACKAGE_LAYOUT_VERSION) &&
    file.appProperties?.syncSchema === '1' &&
    typeof hash === 'string' &&
    /^[a-f0-9]{64}$/u.test(hash) &&
    file.name === `paper-layout-v${LEGACY_PAPER_PACKAGE_LAYOUT_VERSION}-${hash}.json`,
  );
}

function parsePaperLayoutActivation(text: string): PaperLayoutActivationRecord | null {
  if (text.length === 0 || text.length > 1_000_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(value)) return null;
  const expectedKeys = [
    'app',
    'legacyManagedFileIds',
    'paperFolderIds',
    'paperGenerations',
    'paperSyncProtocolVersion',
    'rootFolderId',
    'syncLayoutVersion',
  ];
  if (
    !sameStringSet(Object.keys(value), expectedKeys) ||
    value.app !== '39Note' ||
    value.syncLayoutVersion !== LEGACY_PAPER_PACKAGE_LAYOUT_VERSION ||
    value.paperSyncProtocolVersion !== PAPER_SYNC_PROTOCOL_VERSION ||
    typeof value.rootFolderId !== 'string' ||
    !isSafeDriveId(value.rootFolderId) ||
    !isSafeDriveIdArray(value.paperFolderIds) ||
    !isSafeDriveIdArray(value.legacyManagedFileIds) ||
    !isPlainRecord(value.paperGenerations)
  ) {
    return null;
  }
  const paperGenerations = Object.entries(value.paperGenerations);
  if (
    paperGenerations.length === 0 ||
    paperGenerations.length !== value.paperFolderIds.length ||
    paperGenerations.some(
      ([documentId, generationId]) =>
        !isSafeMigrationDocumentId(documentId) ||
        typeof generationId !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(generationId),
    )
  ) {
    return null;
  }
  return value as unknown as PaperLayoutActivationRecord;
}

function isSafeDriveIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === 'string' && isSafeDriveId(item))
  );
}

function isSafeMigrationDocumentId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !hasControlCharacters(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isLegacyRoleMetadata(file: DriveFileMetadata, role: string): boolean {
  return (
    file.ownedByMe === true &&
    !file.trashed &&
    file.appProperties?.application === '39Note' &&
    file.appProperties.syncSchema === '1' &&
    file.appProperties.layoutVersion === undefined &&
    file.appProperties.paperProtocolVersion === undefined &&
    file.appProperties.role === role
  );
}

function hasExactParent(file: DriveFileMetadata, parentId: string): boolean {
  return file.parents?.length === 1 && file.parents[0] === parentId;
}

function legacyDocumentFolderName(documentId: string): string {
  return `document-${documentId.replace(/[^a-z0-9._-]/giu, '_').slice(0, 96)}`;
}

function isSafeDriveId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
}
