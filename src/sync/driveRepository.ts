import type { StoredPdfFile } from '../services/annotationPersistence.ts';
import {
  combineCloudPayloads,
  CloudPayloadIntegrityError,
  createCloudManifestGeneration,
  encodeCloudPayload,
  IMMUTABLE_MANIFEST_STORAGE,
  isImmutableCloudManifest,
  parseCloudManifest,
  parseCloudPayloadBlob,
  partitionSnapshot,
  payloadForContext,
  replacePayloadForContext,
  verifyCloudManifestGeneration,
  type CloudEntityPayload,
  type CloudDocumentManifest,
  type CloudManifestRecoveryEvidence,
  type ImmutableCloudSyncManifest,
  type CloudPayloadContext,
  type CloudPayloadReference,
  type CloudSyncManifest,
} from './cloudFormat.ts';
import {
  DriveClient,
  DriveRequestError,
  escapeDriveQueryValue,
  type DriveFileMetadata,
} from './driveClient.ts';
import { compareCanonicalStrings, sha256Hex, stableStringify } from './hash.ts';
import { mergeSyncSnapshots } from './merge.ts';
import { assertNoSecretsInSyncPayload } from './secrets.ts';
import {
  SYNC_SCHEMA_VERSION,
  type LocalSyncPdf,
  type SyncDeviceState,
  type SyncConflict,
  type SyncIntegrityIssue,
  type SyncPdfDescriptor,
  type SyncProgress,
  type SyncRemotePullResult,
  type SyncRemotePushResult,
  type SyncRemoteResetResult,
  type SyncRemoteRepository,
  type SyncSnapshot,
} from './types.ts';

const ROOT_NAME = '39Note';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LEGACY_MANIFEST_NAME = '39note-manifest.json';
const MANIFEST_GENERATION_PREFIX = '39note-manifest-v1-';
const LIBRARY_NAME = 'library.json';
const AI_SETTINGS_NAME = 'ai-settings.json';
const DOCUMENTS_NAME = 'documents';
const STATE_NAME = 'state.json';
const PRODUCTIVITY_NAME = 'productivity.json';
const README_NAME = 'README.txt';
const APP_PROPERTIES = { application: '39Note', syncSchema: '1' };
const IMMUTABLE_PAYLOAD_STORAGE = 'immutable-v1' as const;
const PULL_VERIFICATION_ATTEMPTS = 3;
const MANIFEST_DISCOVERY_ATTEMPTS = 3;

interface LoadedManifestGeneration {
  file: DriveFileMetadata;
  manifest: ImmutableCloudSyncManifest;
  snapshot: SyncSnapshot;
}

interface FailedManifestGeneration {
  error: GoogleDrivePayloadIntegrityError;
  manifest: ImmutableCloudSyncManifest;
}

interface LegacyManifestEvidence {
  file: DriveFileMetadata;
  manifest: CloudSyncManifest;
  text: string;
  sourceId: string;
}

interface LoadedLegacyManifest extends LegacyManifestEvidence {
  snapshot: SyncSnapshot;
}

interface ResetManagedArtifacts {
  targets: DriveFileMetadata[];
  documentsFolder?: DriveFileMetadata;
  documentFolders: Map<string, DriveFileMetadata>;
  readme?: DriveFileMetadata;
}

export class MultipleDriveRootsError extends Error {
  readonly roots: DriveFileMetadata[];

  constructor(roots: DriveFileMetadata[]) {
    super(
      'Multiple 39Note folders were found. Choose the folder this device should use.',
    );
    this.name = 'MultipleDriveRootsError';
    this.roots = roots;
  }
}

export class DriveRootUnavailableError extends Error {
  constructor() {
    super(
      'The connected 39Note Drive folder was deleted, trashed, or is no longer accessible. Choose whether to create a replacement folder.',
    );
    this.name = 'DriveRootUnavailableError';
  }
}

export class RemoteManifestChangedError extends Error {
  constructor() {
    super('Google Drive changed while this sync was publishing. Pull and merge again.');
    this.name = 'RemoteManifestChangedError';
  }
}

export class GoogleDrivePayloadIntegrityError extends Error {
  readonly context: CloudPayloadContext;
  readonly reference: CloudPayloadReference;
  readonly manifest: CloudSyncManifest;
  readonly manifestFile: DriveFileMetadata;
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly actualPayload?: CloudEntityPayload;
  readonly cloudCause: CloudPayloadIntegrityError;
  readonly manifestSourceId?: string;
  readonly diagnostic: SyncIntegrityIssue;

  constructor(options: {
    cause: CloudPayloadIntegrityError;
    context: CloudPayloadContext;
    reference: CloudPayloadReference;
    manifest: CloudSyncManifest;
    manifestFile: DriveFileMetadata;
    fileIdFingerprint: string;
    driveFileVersion?: string;
    retryOutcome: SyncIntegrityIssue['retryOutcome'];
    evidenceStable?: boolean;
    manifestSourceId?: string;
  }) {
    super(options.cause.message, { cause: options.cause });
    this.name = 'GoogleDrivePayloadIntegrityError';
    this.context = options.context;
    this.reference = options.reference;
    this.manifest = options.manifest;
    this.manifestFile = options.manifestFile;
    this.expectedHash = options.cause.expectedHash;
    this.actualHash = options.cause.actualHash;
    this.actualPayload = options.cause.actualPayload;
    this.cloudCause = options.cause;
    this.manifestSourceId = options.manifestSourceId;
    this.diagnostic = {
      logicalType: options.context.logicalType,
      logicalPath: options.context.logicalPath,
      ...(options.context.documentId ? { documentId: options.context.documentId } : {}),
      fileIdFingerprint: options.fileIdFingerprint,
      ...(options.driveFileVersion
        ? { driveFileVersion: options.driveFileVersion }
        : {}),
      immutableManifestRecoveryAvailable: Boolean(options.manifestSourceId),
      expectedHashPrefix: options.cause.expectedHash.slice(0, 12),
      actualHashPrefix: options.cause.actualHash.slice(0, 12),
      ...(options.cause.decodedHash
        ? { decodedHashPrefix: options.cause.decodedHash.slice(0, 12) }
        : {}),
      byteLength: options.cause.byteLength,
      ...(options.cause.decodedByteLength !== undefined
        ? { decodedByteLength: options.cause.decodedByteLength }
        : {}),
      actualPayloadValid: options.cause.actualPayloadValid,
      mismatchStage: 'immediately-after-download',
      verificationState: 'mismatch',
      retryOutcome: options.retryOutcome,
      evidenceStable: options.evidenceStable ?? options.retryOutcome === 'persistent',
      validAlternateGenerationAvailable: false,
      localPayloadSemanticallyValid: false,
      remotePayloadSemanticallyValid: false,
      recommendedRecoveryChoices: ['manual-inspection'],
      localRepairAvailable: false,
      remoteMergeAvailable: false,
    };
  }
}

export interface ReadOnlyIntegrityVerificationResult {
  failure: GoogleDrivePayloadIntegrityError | null;
  diagnostic: SyncIntegrityIssue;
  verifiedPayload?: CloudEntityPayload;
}

export class GoogleDriveSyncRepository implements SyncRemoteRepository {
  private rootFolderId: string | null = null;
  private lastManifest: CloudSyncManifest | null = null;
  private lastHeadIds: string[] = [];
  private lastLegacySourceIds: string[] = [];
  private lastLoadedHeads: LoadedManifestGeneration[] = [];
  private lastLegacyEvidence: LegacyManifestEvidence | null = null;
  private lastRecoveryEvidence: CloudManifestRecoveryEvidence[] = [];
  private lastRemoteConflicts: SyncConflict[] = [];

  private readonly drive: DriveClient;

  constructor(drive: DriveClient) {
    this.drive = drive;
  }

  chooseRoot(root: DriveFileMetadata, state: SyncDeviceState): void {
    if (root.mimeType !== FOLDER_MIME || root.trashed) {
      throw new Error('The selected Google Drive item is not a usable 39Note folder.');
    }
    this.rootFolderId = root.id;
    if (state.driveFiles.rootFolderId !== root.id) {
      state.driveFiles = { rootFolderId: root.id, fileIds: {} };
      delete state.remoteManifestVersion;
      delete state.remoteManifest;
      delete state.remoteSnapshot;
      this.lastManifest = null;
      this.lastHeadIds = [];
      this.lastLegacySourceIds = [];
      this.lastLoadedHeads = [];
      this.lastLegacyEvidence = null;
      this.lastRecoveryEvidence = [];
      this.lastRemoteConflicts = [];
    }
  }

  async pull(
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<SyncRemotePullResult> {
    let lastIntegrityError: GoogleDrivePayloadIntegrityError | undefined;
    for (let attempt = 0; attempt < PULL_VERIFICATION_ATTEMPTS; attempt += 1) {
      try {
        return await this.pullOnce(state, signal);
      } catch (error) {
        if (error instanceof GoogleDrivePayloadIntegrityError) {
          if (lastIntegrityError && sameIntegrityEvidence(lastIntegrityError, error)) {
            throw new GoogleDrivePayloadIntegrityError({
              cause: error.cloudCause,
              context: error.context,
              reference: error.reference,
              manifest: error.manifest,
              manifestFile: error.manifestFile,
              fileIdFingerprint: error.diagnostic.fileIdFingerprint,
              retryOutcome: 'persistent',
              ...(error.manifestSourceId
                ? { manifestSourceId: error.manifestSourceId }
                : {}),
            });
          }
          lastIntegrityError = error;
          if (attempt < PULL_VERIFICATION_ATTEMPTS - 1) continue;
          throw new GoogleDrivePayloadIntegrityError({
            cause: error.cloudCause,
            context: error.context,
            reference: error.reference,
            manifest: error.manifest,
            manifestFile: error.manifestFile,
            fileIdFingerprint: error.diagnostic.fileIdFingerprint,
            retryOutcome: 'changed-during-retry',
            ...(error.manifestSourceId
              ? { manifestSourceId: error.manifestSourceId }
              : {}),
          });
        }
        if (
          error instanceof RemoteManifestChangedError &&
          attempt < PULL_VERIFICATION_ATTEMPTS - 1
        ) {
          continue;
        }
        throw error;
      }
    }
    throw lastIntegrityError ?? new Error('Google Drive payload verification failed.');
  }

  private async pullOnce(
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<SyncRemotePullResult> {
    const root = await this.discoverOrCreateRoot(state, signal);
    const discovered = await this.discoverManifestGenerations(root.id, signal);
    const legacyEvidence = await this.readLegacyManifestEvidence(
      root.id,
      state,
      signal,
    );
    this.lastLegacyEvidence = legacyEvidence;
    if (discovered.length > 0) {
      const heads = deriveManifestHeads(discovered);
      let folded = foldManifestHeads(heads);
      this.lastHeadIds = heads.map((head) => head.manifest.generation.id).sort();
      this.lastLoadedHeads = heads;
      this.lastLegacySourceIds = sortedUnique(
        heads.flatMap((head) => head.manifest.generation.legacySources),
      );
      let hasUnincorporatedLegacySource = false;
      if (
        legacyEvidence &&
        !this.lastLegacySourceIds.includes(legacyEvidence.sourceId)
      ) {
        const legacy = await this.loadLegacyManifest(legacyEvidence, signal);
        const merged = mergeSyncSnapshots(
          folded.snapshot,
          legacy.snapshot,
          {},
          deterministicSnapshotTime(folded.snapshot, legacy.snapshot),
        );
        folded = {
          snapshot: merged.snapshot,
          conflicts: mergeConflictEvidence(
            folded.conflicts,
            legacy.manifest.conflicts ?? [],
            merged.conflicts,
          ),
        };
        this.lastLegacySourceIds = sortedUnique([
          ...this.lastLegacySourceIds,
          legacy.sourceId,
        ]);
        hasUnincorporatedLegacySource = true;
      }
      this.lastManifest = heads[0]?.manifest ?? null;
      this.lastRecoveryEvidence = mergeRecoveryEvidenceList(
        heads.flatMap((head) => head.manifest.recoveryEvidence ?? []),
      );
      this.lastRemoteConflicts = folded.conflicts;
      state.remoteManifest = heads[0]?.manifest;
      return {
        snapshot: folded.snapshot,
        manifestVersion: await manifestHeadSetId(this.lastHeadIds),
        rootFolderId: root.id,
        usedCachedSnapshot: false,
        requiresPublicationUpgrade: heads.length !== 1 || hasUnincorporatedLegacySource,
        conflicts: folded.conflicts,
      };
    }

    if (!legacyEvidence) {
      delete state.remoteManifestVersion;
      delete state.remoteManifest;
      delete state.remoteSnapshot;
      this.lastManifest = null;
      this.lastHeadIds = [];
      this.lastLegacySourceIds = [];
      this.lastLoadedHeads = [];
      this.lastLegacyEvidence = null;
      this.lastRecoveryEvidence = [];
      this.lastRemoteConflicts = [];
      return {
        snapshot: emptySnapshot(state.deviceId),
        rootFolderId: root.id,
        usedCachedSnapshot: false,
      };
    }
    const legacy = await this.loadLegacyManifest(legacyEvidence, signal);
    this.lastManifest = legacy.manifest;
    this.lastHeadIds = [];
    this.lastLegacySourceIds = [legacy.sourceId];
    this.lastLoadedHeads = [];
    this.lastRecoveryEvidence = legacy.manifest.recoveryEvidence ?? [];
    this.lastRemoteConflicts = legacy.manifest.conflicts ?? [];
    state.remoteManifest = legacy.manifest;
    return {
      snapshot: legacy.snapshot,
      manifestVersion: legacy.sourceId,
      rootFolderId: root.id,
      usedCachedSnapshot: false,
      requiresPublicationUpgrade: true,
      conflicts: legacy.manifest.conflicts ?? [],
    };
  }

  private async discoverManifestGenerations(
    rootId: string,
    signal: AbortSignal,
  ): Promise<LoadedManifestGeneration[]> {
    const filesById = new Map<string, DriveFileMetadata>();
    const trustedCachedGenerationIds = new Set<string>();
    const trustedCachedFileIds = new Map<string, string>();
    for (const cached of this.lastLoadedHeads) {
      let metadata: DriveFileMetadata;
      try {
        metadata = await this.drive.getMetadata(cached.file.id, signal);
      } catch (error) {
        if (error instanceof DriveRequestError && error.status === 404) continue;
        throw error;
      }
      if (metadata.trashed || !metadata.parents?.includes(rootId)) continue;
      filesById.set(metadata.id, metadata);
      trustedCachedGenerationIds.add(cached.manifest.generation.id);
      trustedCachedFileIds.set(metadata.id, cached.manifest.generation.id);
    }
    const query = [
      `'${escapeDriveQueryValue(rootId)}' in parents`,
      'trashed=false',
      `appProperties has { key='application' and value='39Note' }`,
      `appProperties has { key='role' and value='manifest-generation' }`,
    ].join(' and ');
    for (let attempt = 0; attempt < MANIFEST_DISCOVERY_ATTEMPTS; attempt += 1) {
      for (const file of await this.drive.listFiles(query, signal)) {
        if (file.parents?.includes(rootId) && !file.trashed)
          filesById.set(file.id, file);
      }
    }

    const logical = new Map<string, LoadedManifestGeneration>();
    const failedIntegrityGenerations = new Map<string, FailedManifestGeneration>();
    for (const file of [...filesById.values()].sort((first, second) =>
      compareCanonicalStrings(first.id, second.id),
    )) {
      let loaded: LoadedManifestGeneration | null;
      try {
        loaded = await this.loadManifestGenerationFile(file, rootId, signal);
      } catch (error) {
        if (error instanceof DriveRequestError && error.status === 404) continue;
        if (
          error instanceof GoogleDrivePayloadIntegrityError &&
          isImmutableCloudManifest(error.manifest)
        ) {
          const generationId = error.manifest.generation.id;
          const existing = failedIntegrityGenerations.get(generationId);
          if (
            existing &&
            stableStringify(existing.manifest) !== stableStringify(error.manifest)
          ) {
            throw new Error(
              'Conflicting immutable Drive manifest identities were found.',
            );
          }
          failedIntegrityGenerations.set(generationId, {
            error,
            manifest: error.manifest,
          });
          continue;
        }
        throw error;
      }
      if (!loaded) {
        if (trustedCachedFileIds.has(file.id)) throw new RemoteManifestChangedError();
        continue;
      }
      const generationId = loaded.manifest.generation.id;
      const trustedGenerationId = trustedCachedFileIds.get(file.id);
      if (trustedGenerationId && trustedGenerationId !== generationId) {
        throw new RemoteManifestChangedError();
      }
      const existing = logical.get(generationId);
      if (
        existing &&
        stableStringify(existing.manifest) !== stableStringify(loaded.manifest)
      ) {
        throw new Error('Conflicting immutable Drive manifest identities were found.');
      }
      if (!existing || compareCanonicalStrings(loaded.file.id, existing.file.id) < 0) {
        logical.set(generationId, loaded);
      }
    }

    const recoveredIntegrityEdges = new Set<string>();
    for (const [generationId, failed] of [...failedIntegrityGenerations.entries()].sort(
      ([first], [second]) => compareCanonicalStrings(first, second),
    )) {
      let covered = false;
      for (const child of logical.values()) {
        if (
          await this.manifestGenerationRecoversIntegrityFailure(
            child,
            failed.error,
            signal,
          )
        ) {
          recoveredIntegrityEdges.add(
            manifestParentEdge(child.manifest.generation.id, generationId),
          );
          covered = true;
        }
      }
      if (!covered) throw failed.error;
    }

    const candidates = new Map(logical);
    let removed = true;
    while (removed) {
      removed = false;
      for (const [generationId, child] of candidates) {
        const parents = child.manifest.generation.parents;
        if (
          parents.some(
            (parentId) =>
              !candidates.has(parentId) &&
              !recoveredIntegrityEdges.has(
                manifestParentEdge(child.manifest.generation.id, parentId),
              ) &&
              !trustedCachedGenerationIds.has(child.manifest.generation.id),
          )
        ) {
          candidates.delete(generationId);
          removed = true;
          continue;
        }
        if (
          parents.some((parentId) => {
            const parent = candidates.get(parentId);
            return parent
              ? !manifestGenerationSubsumes(child, parent)
              : !trustedCachedGenerationIds.has(child.manifest.generation.id) &&
                  !recoveredIntegrityEdges.has(
                    manifestParentEdge(child.manifest.generation.id, parentId),
                  );
          })
        ) {
          candidates.delete(generationId);
          removed = true;
        }
      }
    }
    return [...candidates.values()];
  }

  private async loadManifestGenerationFile(
    file: DriveFileMetadata,
    rootId: string,
    signal: AbortSignal,
  ): Promise<LoadedManifestGeneration | null> {
    try {
      file = await this.drive.getMetadata(file.id, signal);
    } catch (error) {
      if (error instanceof DriveRequestError && error.status === 404) return null;
      throw error;
    }
    if (
      file.trashed ||
      !file.parents?.includes(rootId) ||
      file.appProperties?.application !== '39Note' ||
      file.appProperties.role !== 'manifest-generation'
    ) {
      return null;
    }
    let text: string;
    try {
      text = await this.drive.downloadText(file.id, signal);
    } catch (error) {
      if (error instanceof DriveRequestError && error.status === 404) return null;
      throw error;
    }
    let manifest: CloudSyncManifest;
    try {
      manifest = parseCloudManifest(text);
    } catch (error) {
      if (error instanceof Error && /newer version/u.test(error.message)) throw error;
      return null;
    }
    if (
      !isImmutableCloudManifest(manifest) ||
      !(await verifyCloudManifestGeneration(manifest)) ||
      text !== stableStringify(manifest) ||
      file.name !== manifestGenerationName(manifest.generation.id) ||
      file.appProperties.manifestStorage !== IMMUTABLE_MANIFEST_STORAGE ||
      file.appProperties.generationId !== manifest.generation.id
    ) {
      return null;
    }
    let snapshot: SyncSnapshot;
    try {
      snapshot = await this.loadSnapshotFromManifest(
        manifest,
        file,
        manifest.generation.id,
        signal,
      );
      const verifiedRecoveryReferences = new Set<string>();
      for (const evidence of manifest.recoveryEvidence ?? []) {
        const context = payloadContext(evidence.logicalType, evidence.documentId);
        for (const reference of [
          evidence.expected,
          ...(evidence.observed ? [evidence.observed] : []),
          evidence.merged,
        ]) {
          const key = stableStringify({ context, reference });
          if (verifiedRecoveryReferences.has(key)) continue;
          await parseCloudPayloadBlob(
            await this.drive.downloadBlob(reference.fileId, signal),
            reference.sha256,
            context,
          );
          verifiedRecoveryReferences.add(key);
        }
      }
      for (const document of manifest.documents) {
        await this.verifyReferencedPdf(document.pdf, signal);
      }
    } catch (error) {
      if (error instanceof DriveRequestError && error.status === 404) {
        throw new Error(
          'An immutable Drive manifest references a missing payload generation.',
          { cause: error },
        );
      }
      throw error;
    }
    let verifiedText: string;
    let verifiedFile: DriveFileMetadata;
    try {
      [verifiedText, verifiedFile] = await Promise.all([
        this.drive.downloadText(file.id, signal),
        this.drive.getMetadata(file.id, signal),
      ]);
    } catch (error) {
      if (error instanceof DriveRequestError && error.status === 404) {
        throw new RemoteManifestChangedError();
      }
      throw error;
    }
    if (verifiedFile.trashed || !verifiedFile.parents?.includes(rootId)) return null;
    if (
      verifiedText !== text ||
      !matchesManifestGenerationFile(verifiedFile, rootId, manifest)
    ) {
      throw new RemoteManifestChangedError();
    }
    return {
      file: verifiedFile,
      manifest,
      snapshot,
    };
  }

  private async manifestGenerationRecoversIntegrityFailure(
    child: LoadedManifestGeneration,
    failure: GoogleDrivePayloadIntegrityError,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!isImmutableCloudManifest(failure.manifest)) return false;
    const parent = failure.manifest;
    if (!child.manifest.generation.parents.includes(parent.generation.id)) {
      return false;
    }
    const parentReference = referenceForContext(parent, failure.context);
    const childReference = referenceForContext(child.manifest, failure.context);
    if (!parentReference || !childReference) return false;
    const matchingEvidence = (child.manifest.recoveryEvidence ?? []).filter(
      (evidence) =>
        evidence.sourceManifestId === parent.generation.id &&
        evidence.logicalType === failure.context.logicalType &&
        evidence.documentId === failure.context.documentId,
    );
    for (const evidence of matchingEvidence) {
      if (
        evidence.expected.sha256 !== parentReference.sha256 ||
        stableStringify(evidence.merged) !== stableStringify(childReference) ||
        !manifestRecoveryPreservesParent(parent, child.manifest, failure.context)
      ) {
        continue;
      }
      if (failure.actualPayload) {
        if (!evidence.observed) continue;
        const observed = await parseCloudPayloadBlob(
          await this.drive.downloadBlob(evidence.observed.fileId, signal),
          evidence.observed.sha256,
          failure.context,
        );
        if (
          cloudPayloadContent(observed) !== cloudPayloadContent(failure.actualPayload)
        ) {
          continue;
        }
      } else if (evidence.observed) {
        continue;
      }
      return true;
    }
    return false;
  }

  private async readLegacyManifestEvidence(
    rootId: string,
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<LegacyManifestEvidence | null> {
    const evidence = await this.readLegacyManifestEvidenceAt(
      rootId,
      state.driveFiles.manifestFileId,
      signal,
    );
    if (evidence) state.driveFiles.manifestFileId = evidence.file.id;
    return evidence;
  }

  private async readLegacyManifestEvidenceAt(
    rootId: string,
    cachedFileId: string | undefined,
    signal: AbortSignal,
  ): Promise<LegacyManifestEvidence | null> {
    const file = await this.findFile(
      rootId,
      LEGACY_MANIFEST_NAME,
      cachedFileId,
      signal,
      undefined,
      true,
    );
    if (!file) return null;
    const text = await this.drive.downloadText(file.id, signal);
    const manifest = parseCloudManifest(text);
    if (isImmutableCloudManifest(manifest)) {
      throw new Error(
        'An immutable manifest generation used the reserved legacy name.',
      );
    }
    const sourceId = await legacyManifestSourceId(file.id, text);
    return { file, manifest, text, sourceId };
  }

  private async loadLegacyManifest(
    evidence: LegacyManifestEvidence,
    signal: AbortSignal,
  ): Promise<LoadedLegacyManifest> {
    const { file, manifest, text, sourceId } = evidence;
    const snapshot = await this.loadSnapshotFromManifest(
      manifest,
      file,
      sourceId,
      signal,
    );
    if ((await this.drive.downloadText(file.id, signal)) !== text) {
      throw new RemoteManifestChangedError();
    }
    return { file, manifest, text, sourceId, snapshot };
  }

  private async assertLegacyEvidenceUnchanged(
    rootId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const expected = this.lastLegacyEvidence;
    const current = await this.readLegacyManifestEvidenceAt(
      rootId,
      expected?.file.id,
      signal,
    );
    if (!expected) {
      if (current) throw new RemoteManifestChangedError();
      return;
    }
    if (!current || current.file.id !== expected.file.id) {
      throw new RemoteManifestChangedError();
    }
    if (current.text !== expected.text || current.sourceId !== expected.sourceId) {
      throw new RemoteManifestChangedError();
    }
  }

  private async loadSnapshotFromManifest(
    manifest: CloudSyncManifest,
    manifestFile: DriveFileMetadata,
    manifestSourceId: string,
    signal: AbortSignal,
  ): Promise<SyncSnapshot> {
    const [library, aiSettings] = await Promise.all([
      this.downloadPayload(
        manifest.library,
        payloadContext('library-metadata'),
        manifest,
        manifestFile,
        signal,
        manifestSourceId,
      ),
      this.downloadPayload(
        manifest.aiSettings,
        payloadContext('ai-settings'),
        manifest,
        manifestFile,
        signal,
        manifestSourceId,
      ),
    ]);
    const documentPayloads = await Promise.all(
      manifest.documents.flatMap((document) => [
        this.downloadPayload(
          document.state,
          payloadContext('document-state', document.documentId),
          manifest,
          manifestFile,
          signal,
          manifestSourceId,
        ),
        ...(document.productivity
          ? [
              this.downloadPayload(
                document.productivity,
                payloadContext('productivity-data', document.documentId),
                manifest,
                manifestFile,
                signal,
                manifestSourceId,
              ),
            ]
          : []),
      ]),
    );
    return combineCloudPayloads(manifest, library, aiSettings, documentPayloads);
  }

  async downloadPdf(
    pdf: SyncPdfDescriptor,
    signal: AbortSignal,
  ): Promise<StoredPdfFile> {
    if (!pdf.fileId)
      throw new Error(`Cloud PDF ${pdf.documentId} has no Drive file ID.`);
    const blob = await this.drive.downloadBlob(pdf.fileId, signal);
    if (blob.size !== pdf.size || (await sha256Hex(blob)) !== pdf.sha256) {
      throw new Error(`Original PDF for ${pdf.documentId} failed its integrity check.`);
    }
    return {
      documentId: pdf.documentId,
      fileName: pdf.fileName,
      mimeType: pdf.mimeType,
      size: pdf.size,
      lastModified: pdf.lastModified,
      storedAt: pdf.storedAt,
      blob,
    };
  }

  async push(
    snapshot: SyncSnapshot,
    localPdfs: readonly LocalSyncPdf[],
    state: SyncDeviceState,
    signal: AbortSignal,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncRemotePushResult> {
    assertNoSecretsInSyncPayload(snapshot);
    const root = await this.discoverOrCreateRoot(state, signal);
    let filesUpdated = 0;
    const documentsFolder = await this.ensureFolder(
      DOCUMENTS_NAME,
      root.id,
      { ...APP_PROPERTIES, role: 'documents' },
      'documents-folder',
      state,
      signal,
    );
    state.driveFiles.documentsFolderId = documentsFolder.id;
    if (await this.ensureReadme(root.id, state, signal)) filesUpdated += 1;

    const partitions = partitionSnapshot(snapshot);
    const immutablePrior =
      this.lastManifest?.payloadStorage === IMMUTABLE_PAYLOAD_STORAGE
        ? this.lastManifest
        : undefined;
    const libraryEncoded = await encodeCloudPayload(partitions.library);
    const library = await this.putJson(
      LIBRARY_NAME,
      root.id,
      libraryEncoded,
      immutablePrior?.library,
      'library',
      state,
      signal,
    );
    if (library.changed) filesUpdated += 1;
    const aiEncoded = await encodeCloudPayload(partitions.aiSettings);
    const aiSettings = await this.putJson(
      AI_SETTINGS_NAME,
      root.id,
      aiEncoded,
      immutablePrior?.aiSettings,
      'ai-settings',
      state,
      signal,
    );
    if (aiSettings.changed) filesUpdated += 1;

    const localPdfByDocument = new Map(localPdfs.map((pdf) => [pdf.documentId, pdf]));
    const priorDocumentById = new Map(
      this.lastManifest?.documents.map((document) => [document.documentId, document]) ??
        [],
    );
    const documentManifests: CloudDocumentManifest[] = [];
    let pdfsUploaded = 0;
    let completedPdfs = 0;
    const totalPdfs = snapshot.pdfs.filter((descriptor) => {
      const priorPdf = priorDocumentById.get(descriptor.documentId)?.pdf;
      return !(
        (priorPdf?.sha256 === descriptor.sha256 && priorPdf.fileId) ||
        descriptor.fileId
      );
    }).length;

    for (const [documentId, partition] of [...partitions.documents].sort(
      ([first], [second]) => compareCanonicalStrings(first, second),
    )) {
      const prior = priorDocumentById.get(documentId);
      const folder = prior
        ? ({ id: prior.folderId } as DriveFileMetadata)
        : await this.ensureFolder(
            documentFolderName(documentId),
            documentsFolder.id,
            { ...APP_PROPERTIES, role: 'document', documentId },
            `document-folder:${documentId}`,
            state,
            signal,
          );
      const stateEncoded = await encodeCloudPayload(partition.state);
      const stateFile = await this.putJson(
        STATE_NAME,
        folder.id,
        stateEncoded,
        immutablePrior
          ? immutablePrior.documents.find(
              (document) => document.documentId === documentId,
            )?.state
          : undefined,
        `state:${documentId}`,
        state,
        signal,
      );
      if (stateFile.changed) filesUpdated += 1;
      const productivityEncoded = await encodeCloudPayload(partition.productivity);
      const productivityFile = await this.putJson(
        PRODUCTIVITY_NAME,
        folder.id,
        productivityEncoded,
        immutablePrior
          ? immutablePrior.documents.find(
              (document) => document.documentId === documentId,
            )?.productivity
          : undefined,
        `productivity:${documentId}`,
        state,
        signal,
      );
      if (productivityFile.changed) filesUpdated += 1;

      const pdfDescriptor = snapshot.pdfs.find((pdf) => pdf.documentId === documentId);
      let cloudPdf: CloudDocumentManifest['pdf'];
      if (pdfDescriptor) {
        const priorPdf = prior?.pdf;
        if (priorPdf?.sha256 === pdfDescriptor.sha256 && priorPdf.fileId) {
          cloudPdf = { ...pdfDescriptor, fileId: priorPdf.fileId };
        } else if (pdfDescriptor.fileId) {
          cloudPdf = { ...pdfDescriptor, fileId: pdfDescriptor.fileId };
        } else {
          const localPdf = localPdfByDocument.get(documentId);
          if (!localPdf)
            throw new Error(
              `Local original PDF ${documentId} is unavailable for upload.`,
            );
          onProgress?.({
            phase: 'uploading',
            completed: completedPdfs,
            total: totalPdfs,
            detail: localPdf.fileName,
          });
          const uploaded = await this.drive.uploadFile(
            pdfGenerationName(localPdf.sha256),
            localPdf.blob,
            {
              parents: [folder.id],
              appProperties: {
                ...APP_PROPERTIES,
                role: 'original-pdf',
                documentId,
                sha256: localPdf.sha256,
              },
            },
            signal,
            (bytes, total) =>
              onProgress?.({
                phase: 'uploading',
                completed: completedPdfs,
                total: totalPdfs,
                bytesCompleted: bytes,
                bytesTotal: total,
                detail: localPdf.fileName,
              }),
          );
          state.driveFiles.fileIds[`pdf:${documentId}`] = uploaded.id;
          cloudPdf = { ...pdfDescriptor, fileId: uploaded.id };
          pdfsUploaded += 1;
          filesUpdated += 1;
          completedPdfs += 1;
          onProgress?.({
            phase: 'uploading',
            completed: completedPdfs,
            total: totalPdfs,
            detail: `${localPdf.fileName} uploaded`,
          });
        }
      }
      if (cloudPdf) await this.verifyReferencedPdf(cloudPdf, signal);
      documentManifests.push({
        documentId,
        folderId: folder.id,
        state: stateFile.reference,
        productivity: productivityFile.reference,
        ...(cloudPdf ? { pdf: cloudPdf } : {}),
      });
    }

    const manifestBase: CloudSyncManifest = {
      app: '39Note',
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      generatedAt: snapshot.generatedAt,
      generatedBy: snapshot.generatedBy,
      payloadStorage: IMMUTABLE_PAYLOAD_STORAGE,
      conflicts: mergeConflictEvidence(this.lastRemoteConflicts, state.conflicts),
      ...(this.lastRecoveryEvidence.length > 0
        ? { recoveryEvidence: this.lastRecoveryEvidence }
        : {}),
      library: library.reference,
      aiSettings: aiSettings.reference,
      documents: documentManifests,
    };
    assertNoSecretsInSyncPayload(manifestBase);
    onProgress?.({
      phase: 'publishing',
      detail: 'Publishing immutable Drive generation',
    });
    const published = await this.publishManifestGeneration(
      manifestBase,
      root.id,
      signal,
    );
    if (published.changed) filesUpdated += 1;
    state.remoteManifest = published.manifest;
    const pushedSnapshot: SyncSnapshot = {
      ...snapshot,
      pdfs: documentManifests.flatMap((document) =>
        document.pdf ? [document.pdf] : [],
      ),
    };
    return {
      snapshot: pushedSnapshot,
      manifestVersion: published.manifest.generation.id,
      pdfsUploaded,
      filesUpdated,
    };
  }

  async resetFromLocal(
    snapshot: SyncSnapshot,
    localPdfs: readonly LocalSyncPdf[],
    state: SyncDeviceState,
    signal: AbortSignal,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncRemoteResetResult> {
    const resetSnapshot = snapshotWithoutDrivePdfIds(snapshot);
    const resetPdfs = localPdfs.map(withoutDrivePdfId);
    await validateResetSource(resetSnapshot, resetPdfs);
    signal.throwIfAborted();

    const root = await this.requireSelectedResetRoot(state, signal);
    const preflight = await this.discoverResetManagedArtifacts(root.id, signal);
    onProgress?.({
      phase: 'resetting',
      completed: 0,
      total: preflight.targets.length,
      detail: 'Preparing managed Drive artifacts',
    });

    let filesTrashed = 0;
    for (const target of preflight.targets) {
      signal.throwIfAborted();
      const current = await this.drive.getMetadata(target.id, signal);
      if (!sameResetCandidate(target, current)) {
        throw new RemoteManifestChangedError();
      }
      const trashed = await this.drive.trashManagedFileForReset(target.id, signal);
      if (trashed.id !== target.id || trashed.trashed !== true) {
        throw new Error('Google Drive did not confirm removal of a managed sync file.');
      }
      filesTrashed += 1;
      onProgress?.({
        phase: 'resetting',
        completed: filesTrashed,
        total: preflight.targets.length,
        detail: target.name,
      });
    }

    const remaining = await this.discoverResetManagedArtifacts(root.id, signal);
    if (remaining.targets.length > 0 || !sameResetFolderLayout(preflight, remaining)) {
      throw new Error(
        'Google Drive changed during reset. Close 39Note on other devices and retry.',
      );
    }

    this.clearRemoteCachesForReset(state, root.id, remaining);
    onProgress?.({
      phase: 'uploading',
      detail: 'Publishing this device as the authoritative copy',
    });
    const pushed = await this.push(resetSnapshot, resetPdfs, state, signal, onProgress);
    signal.throwIfAborted();
    onProgress?.({
      phase: 'verifying',
      detail: 'Re-reading the rebuilt immutable generation',
    });
    const verified = await this.pull(state, signal);
    const verifiedManifest = state.remoteManifest;
    if (
      verified.requiresPublicationUpgrade ||
      verified.manifestVersion !== pushed.manifestVersion ||
      !verifiedManifest ||
      !isImmutableCloudManifest(verifiedManifest) ||
      verifiedManifest.generation.id !== pushed.manifestVersion ||
      verifiedManifest.generation.parents.length !== 0 ||
      verifiedManifest.generation.legacySources.length !== 0 ||
      (verifiedManifest.recoveryEvidence?.length ?? 0) !== 0 ||
      canonicalResetSnapshot(verified.snapshot) !==
        canonicalResetSnapshot(pushed.snapshot)
    ) {
      throw new Error(
        'The rebuilt Google Drive generation could not be verified. Local data remains authoritative.',
      );
    }
    return {
      snapshot: verified.snapshot,
      manifestVersion: pushed.manifestVersion,
      pdfsUploaded: pushed.pdfsUploaded,
      filesUpdated: pushed.filesUpdated,
      filesTrashed,
    };
  }

  getRootFolderUrl(): string | null {
    return this.rootFolderId
      ? `https://drive.google.com/drive/folders/${encodeURIComponent(this.rootFolderId)}`
      : null;
  }

  private async publishManifestGeneration(
    manifestBase: CloudSyncManifest,
    rootId: string,
    signal: AbortSignal,
  ): Promise<{
    manifest: ImmutableCloudSyncManifest;
    file: DriveFileMetadata;
    changed: boolean;
  }> {
    await this.assertLegacyEvidenceUnchanged(rootId, signal);
    await this.verifyManifestReferencesForPublication(manifestBase, signal);
    const manifest = await createCloudManifestGeneration(manifestBase, {
      createdAt: manifestBase.generatedAt,
      createdBy: manifestBase.generatedBy,
      parents: this.lastHeadIds,
      legacySources: this.lastLegacySourceIds,
    });
    assertNoSecretsInSyncPayload(manifest);
    const text = stableStringify(manifest);
    const name = manifestGenerationName(manifest.generation.id);
    const existing = await this.findReusableManifestGeneration(
      rootId,
      name,
      text,
      signal,
    );
    const file =
      existing ??
      (await this.drive.uploadFile(
        name,
        new Blob([text], { type: 'application/json' }),
        {
          parents: [rootId],
          appProperties: {
            ...APP_PROPERTIES,
            role: 'manifest-generation',
            manifestStorage: IMMUTABLE_MANIFEST_STORAGE,
            generationId: manifest.generation.id,
          },
        },
        signal,
      ));
    if ((await this.drive.downloadText(file.id, signal)) !== text) {
      throw new Error(
        'Google Drive manifest-generation verification failed. Existing heads remain unchanged.',
      );
    }
    const published = await this.loadManifestGenerationFile(file, rootId, signal);
    if (!published || published.manifest.generation.id !== manifest.generation.id) {
      throw new Error(
        'Google Drive did not retain the exact immutable manifest generation.',
      );
    }
    const knownParents = new Map(
      this.lastLoadedHeads.map((parent) => [parent.manifest.generation.id, parent]),
    );
    for (const parentId of manifest.generation.parents) {
      const parent = knownParents.get(parentId);
      if (parent && !manifestGenerationSubsumes(published, parent)) {
        throw new Error(
          'The new immutable manifest does not preserve all parent state and evidence.',
        );
      }
    }

    const freshlyDiscovered = await this.discoverManifestGenerations(rootId, signal);
    await this.assertLegacyEvidenceUnchanged(rootId, signal);
    const allKnown = dedupeManifestGenerations([
      ...this.lastLoadedHeads,
      ...freshlyDiscovered,
      published,
    ]);
    const heads = deriveManifestHeads(allKnown);
    if (
      heads.length !== 1 ||
      heads[0].manifest.generation.id !== manifest.generation.id
    ) {
      throw new RemoteManifestChangedError();
    }
    this.lastManifest = manifest;
    this.lastHeadIds = [manifest.generation.id];
    this.lastLegacySourceIds = manifest.generation.legacySources;
    this.lastLoadedHeads = [published];
    this.lastRecoveryEvidence = manifest.recoveryEvidence ?? [];
    this.lastRemoteConflicts = manifest.conflicts;
    return { manifest, file, changed: !existing };
  }

  private async verifyManifestReferencesForPublication(
    manifest: CloudSyncManifest,
    signal: AbortSignal,
  ): Promise<void> {
    const references: Array<{
      reference: CloudPayloadReference;
      context: CloudPayloadContext;
    }> = [
      {
        reference: manifest.library,
        context: payloadContext('library-metadata'),
      },
      {
        reference: manifest.aiSettings,
        context: payloadContext('ai-settings'),
      },
      ...manifest.documents.flatMap((document) => [
        {
          reference: document.state,
          context: payloadContext('document-state', document.documentId),
        },
        ...(document.productivity
          ? [
              {
                reference: document.productivity,
                context: payloadContext('productivity-data', document.documentId),
              },
            ]
          : []),
      ]),
      ...(manifest.recoveryEvidence ?? []).flatMap((evidence) => {
        const context = payloadContext(evidence.logicalType, evidence.documentId);
        return [
          { reference: evidence.expected, context },
          ...(evidence.observed ? [{ reference: evidence.observed, context }] : []),
          { reference: evidence.merged, context },
        ];
      }),
    ];
    const verified = new Set<string>();
    for (const { reference, context } of references) {
      const key = stableStringify({ reference, context });
      if (verified.has(key)) continue;
      await parseCloudPayloadBlob(
        await this.drive.downloadBlob(reference.fileId, signal),
        reference.sha256,
        context,
      );
      verified.add(key);
    }
    for (const document of manifest.documents) {
      await this.verifyReferencedPdf(document.pdf, signal);
    }
  }

  private async findReusableManifestGeneration(
    rootId: string,
    name: string,
    expectedText: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata | null> {
    const query = [
      `'${escapeDriveQueryValue(rootId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
      `appProperties has { key='role' and value='manifest-generation' }`,
    ].join(' and ');
    const matches = dedupeDriveFiles(await this.drive.listFiles(query, signal));
    for (const match of matches) {
      if (
        match.parents?.includes(rootId) &&
        match.appProperties?.role === 'manifest-generation' &&
        (await this.drive.downloadText(match.id, signal)) === expectedText
      ) {
        return match;
      }
    }
    return null;
  }

  private async discoverOrCreateRoot(
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const cached = state.driveFiles.rootFolderId;
    if (cached) {
      try {
        const metadata = await this.drive.getMetadata(cached, signal);
        if (metadata.mimeType === FOLDER_MIME && !metadata.trashed) {
          this.assertSingleRoot([metadata, ...(await this.listAppOwnedRoots(signal))]);
          this.rootFolderId = metadata.id;
          return metadata;
        }
      } catch (error) {
        if (!(error instanceof DriveRequestError) || error.status !== 404) throw error;
        throw new DriveRootUnavailableError();
      }
      throw new DriveRootUnavailableError();
    }

    const discovered = await this.discoverExistingRoot(signal);
    if (discovered) return this.cacheRoot(discovered, state);

    const confirmed = await this.discoverExistingRoot(signal);
    if (confirmed) return this.cacheRoot(confirmed, state);

    const created = await this.drive.createFolder(
      ROOT_NAME,
      null,
      { ...APP_PROPERTIES, role: 'root' },
      signal,
    );
    this.assertSingleRoot([created, ...(await this.listAppOwnedRoots(signal))]);
    return this.cacheRoot(created, state);
  }

  private async discoverExistingRoot(
    signal: AbortSignal,
  ): Promise<DriveFileMetadata | null> {
    const appOwned = await this.listAppOwnedRoots(signal);
    this.assertSingleRoot(appOwned);
    if (appOwned.length === 1) return appOwned[0];

    const exact = await this.drive.listFiles(
      `name='${escapeDriveQueryValue(ROOT_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      signal,
    );
    if (exact.length > 1) throw new MultipleDriveRootsError(exact);
    if (exact.length === 0) return null;

    const claimed = await this.drive.updateMetadata(
      exact[0].id,
      {
        appProperties: { ...APP_PROPERTIES, role: 'root' },
      },
      signal,
    );
    this.assertSingleRoot([claimed, ...(await this.listAppOwnedRoots(signal))]);
    return claimed;
  }

  private listAppOwnedRoots(signal: AbortSignal): Promise<DriveFileMetadata[]> {
    return this.drive.listFiles(
      `mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='application' and value='39Note' } and appProperties has { key='role' and value='root' }`,
      signal,
    );
  }

  private assertSingleRoot(candidates: readonly DriveFileMetadata[]): void {
    const unique = [...new Map(candidates.map((root) => [root.id, root])).values()];
    if (unique.length > 1) throw new MultipleDriveRootsError(unique);
  }

  private cacheRoot(
    root: DriveFileMetadata,
    state: SyncDeviceState,
  ): DriveFileMetadata {
    state.driveFiles.rootFolderId = root.id;
    this.rootFolderId = root.id;
    return root;
  }

  private async downloadPayload(
    reference: CloudPayloadReference,
    context: CloudPayloadContext,
    manifest: CloudSyncManifest,
    manifestFile: DriveFileMetadata,
    signal: AbortSignal,
    manifestSourceId?: string,
  ): Promise<CloudEntityPayload> {
    try {
      return await parseCloudPayloadBlob(
        await this.drive.downloadBlob(reference.fileId, signal),
        reference.sha256,
        context,
      );
    } catch (error) {
      if (!(error instanceof CloudPayloadIntegrityError)) throw error;
      throw new GoogleDrivePayloadIntegrityError({
        cause: error,
        context,
        reference,
        manifest,
        manifestFile,
        fileIdFingerprint: (await sha256Hex(reference.fileId)).slice(0, 12),
        retryOutcome: 'not-retried',
        ...(manifestSourceId ? { manifestSourceId } : {}),
      });
    }
  }

  async verifyIntegrityFailureReadOnly(
    failure: GoogleDrivePayloadIntegrityError,
    signal: AbortSignal,
  ): Promise<ReadOnlyIntegrityVerificationResult> {
    let current: Awaited<ReturnType<typeof this.loadUnchangedFailedManifest>>;
    try {
      current = await this.loadUnchangedFailedManifest(failure, signal);
    } catch (error) {
      if (!(error instanceof RemoteManifestChangedError)) throw error;
      return {
        failure,
        diagnostic: changedIntegrityDiagnostic(failure.diagnostic),
      };
    }
    const { manifest, file: manifestFile, text: manifestText, sourceId } = current;
    const reference = referenceForContext(manifest, failure.context);
    if (!reference) {
      return {
        failure,
        diagnostic: changedIntegrityDiagnostic(failure.diagnostic),
      };
    }
    const fileMetadataBefore = await this.drive.getMetadata(reference.fileId, signal);
    const blob = await this.drive.downloadBlob(reference.fileId, signal);
    const [fileMetadata, manifestTextAfter] = await Promise.all([
      this.drive.getMetadata(reference.fileId, signal),
      this.drive.downloadText(manifestFile.id, signal),
    ]);
    const versionsStable =
      sameDriveVersion(fileMetadataBefore.version, fileMetadata.version) &&
      manifestTextAfter === manifestText;
    const fileIdFingerprint = (await sha256Hex(reference.fileId)).slice(0, 12);
    const driveFileVersion = safeDriveFileVersion(fileMetadata.version);
    try {
      const verifiedPayload = await parseCloudPayloadBlob(
        blob,
        reference.sha256,
        failure.context,
      );
      const actualHash = await sha256Hex(blob);
      if (!versionsStable) {
        return {
          failure,
          diagnostic: {
            ...changedIntegrityDiagnostic(failure.diagnostic),
            fileIdFingerprint,
            ...(driveFileVersion ? { driveFileVersion } : {}),
            immutableManifestRecoveryAvailable: true,
            expectedHashPrefix: reference.sha256.slice(0, 12),
            actualHashPrefix: actualHash.slice(0, 12),
            byteLength: blob.size,
            decodedByteLength: blob.size,
            actualPayloadValid: true,
          },
        };
      }
      return {
        failure: null,
        verifiedPayload,
        diagnostic: {
          ...failure.diagnostic,
          fileIdFingerprint,
          ...(driveFileVersion ? { driveFileVersion } : {}),
          immutableManifestRecoveryAvailable: true,
          expectedHashPrefix: reference.sha256.slice(0, 12),
          actualHashPrefix: actualHash.slice(0, 12),
          byteLength: blob.size,
          decodedByteLength: blob.size,
          actualPayloadValid: true,
          verificationState: 'verified',
          retryOutcome: 'recovered',
          evidenceStable: false,
          validAlternateGenerationAvailable: false,
          localPayloadSemanticallyValid: false,
          remotePayloadSemanticallyValid: false,
          recommendedRecoveryChoices: ['continue-sync'],
          localRepairAvailable: false,
          remoteMergeAvailable: false,
        },
      };
    } catch (error) {
      if (!(error instanceof CloudPayloadIntegrityError)) throw error;
      const changedFailure = new GoogleDrivePayloadIntegrityError({
        cause: error,
        context: failure.context,
        reference,
        manifest,
        manifestFile,
        fileIdFingerprint,
        ...(driveFileVersion ? { driveFileVersion } : {}),
        retryOutcome: 'changed-during-retry',
        evidenceStable: false,
        manifestSourceId: sourceId,
      });
      if (!versionsStable || !sameIntegrityEvidence(failure, changedFailure)) {
        return { failure: changedFailure, diagnostic: changedFailure.diagnostic };
      }
      const stableFailure = new GoogleDrivePayloadIntegrityError({
        cause: error,
        context: failure.context,
        reference,
        manifest,
        manifestFile,
        fileIdFingerprint,
        ...(driveFileVersion ? { driveFileVersion } : {}),
        retryOutcome: 'persistent',
        evidenceStable: true,
        manifestSourceId: sourceId,
      });
      return { failure: stableFailure, diagnostic: stableFailure.diagnostic };
    }
  }

  async canRepairFromSnapshot(
    failure: GoogleDrivePayloadIntegrityError,
    snapshot: SyncSnapshot,
  ): Promise<boolean> {
    if (failure.actualPayload) return false;
    const candidate = payloadForContext(snapshot, failure.context);
    return (
      Boolean(candidate) &&
      (await encodeCloudPayload(candidate as CloudEntityPayload)).sha256 ===
        failure.expectedHash
    );
  }

  async repairPayloadFromSnapshot(
    failure: GoogleDrivePayloadIntegrityError,
    snapshot: SyncSnapshot,
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<SyncConflict[]> {
    const recoveryDirtyGeneration = state.dirtyGeneration;
    if (failure.actualPayload) {
      throw new Error(
        'The mismatched Drive bytes are a valid concurrent generation and must be merged, not overwritten.',
      );
    }
    const candidate = payloadForContext(snapshot, failure.context);
    if (!candidate)
      throw new Error('No matching local sync partition is available for repair.');
    const encoded = await encodeCloudPayload(candidate);
    if (encoded.sha256 !== failure.expectedHash) {
      throw new Error(
        'The local copy no longer matches the failed Drive generation. Retry verification first.',
      );
    }

    if (!isImmutableCloudManifest(failure.manifest)) {
      await this.assertRecoveryHasNoPublishedSuccess(signal);
    }
    const current = await this.loadUnchangedFailedManifest(failure, signal);
    await this.revalidateFailedPayload(failure, signal);
    const repairedPayload = await this.putJson(
      basePayloadName(failure.context),
      parentIdForContext(current.manifest, failure.context, this.rootFolderId),
      encoded,
      undefined,
      cacheKeyForContext(failure.context),
      state,
      signal,
      failure.reference.fileId,
    );
    const manifestBase = await this.materializeRecoveryManifest(
      current.manifest,
      failure.context,
      repairedPayload.reference,
      state,
      signal,
    );
    const finalSource = await this.loadUnchangedFailedManifest(failure, signal);
    if (finalSource.sourceId !== current.sourceId)
      throw new RemoteManifestChangedError();
    await this.revalidateFailedPayload(failure, signal);
    if (state.dirtyGeneration !== recoveryDirtyGeneration) {
      throw new RemoteManifestChangedError();
    }
    if (!this.rootFolderId) throw new RemoteManifestChangedError();
    await this.publishManifestGeneration(
      {
        ...manifestBase,
        generatedAt: Date.now(),
        generatedBy: state.deviceId,
        conflicts: mergeConflictEvidence(
          current.manifest.conflicts ?? [],
          state.conflicts,
        ),
        recoveryEvidence: mergeRecoveryEvidence(
          current.manifest.recoveryEvidence ?? [],
          {
            sourceManifestId: current.sourceId,
            logicalType: failure.context.logicalType,
            ...(failure.context.documentId
              ? { documentId: failure.context.documentId }
              : {}),
            expected: repairedPayload.reference,
            merged: repairedPayload.reference,
          },
        ),
      },
      this.rootFolderId,
      signal,
    );
    this.clearCachedRemoteAfterRecovery(state);
    return [];
  }

  async canMergeValidRemoteFromSnapshot(
    failure: GoogleDrivePayloadIntegrityError,
    snapshot: SyncSnapshot,
  ): Promise<boolean> {
    if (!failure.actualPayload) return false;
    const expectedLocal = payloadForContext(snapshot, failure.context);
    return (
      Boolean(expectedLocal) &&
      (await encodeCloudPayload(expectedLocal as CloudEntityPayload)).sha256 ===
        failure.expectedHash
    );
  }

  async repairFromValidRemoteGeneration(
    failure: GoogleDrivePayloadIntegrityError,
    snapshot: SyncSnapshot,
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<SyncConflict[]> {
    const recoveryDirtyGeneration = state.dirtyGeneration;
    if (!failure.actualPayload) {
      throw new Error('The mismatched Drive bytes are not a valid remote generation.');
    }
    if (!(await this.canMergeValidRemoteFromSnapshot(failure, snapshot))) {
      throw new Error(
        'The expected local generation is unavailable, so 39Note refused to replace its manifest reference.',
      );
    }
    if (!isImmutableCloudManifest(failure.manifest)) {
      await this.assertRecoveryHasNoPublishedSuccess(signal);
    }
    const current = await this.loadUnchangedFailedManifest(failure, signal);
    const currentRemotePayload = await this.revalidateFailedPayload(failure, signal);
    if (!currentRemotePayload) throw new RemoteManifestChangedError();
    const expectedPayload = payloadForContext(snapshot, failure.context);
    if (!expectedPayload) throw new RemoteManifestChangedError();
    const expectedEncoded = await encodeCloudPayload(expectedPayload);
    const remoteEncoded = await encodeCloudPayload(currentRemotePayload);
    const parentId = parentIdForContext(
      current.manifest,
      failure.context,
      this.rootFolderId,
    );
    const preservedExpected = await this.putJson(
      basePayloadName(failure.context),
      parentId,
      expectedEncoded,
      undefined,
      cacheKeyForContext(failure.context),
      state,
      signal,
      failure.reference.fileId,
    );
    const preservedRemote = await this.putJson(
      basePayloadName(failure.context),
      parentId,
      remoteEncoded,
      undefined,
      cacheKeyForContext(failure.context),
      state,
      signal,
      failure.reference.fileId,
    );
    const remoteVariant = replacePayloadForContext(
      snapshot,
      failure.context,
      currentRemotePayload,
    );
    if (!remoteVariant) throw new RemoteManifestChangedError();
    const observedAt = deterministicSnapshotTime(snapshot, remoteVariant);
    const merged = mergeSyncSnapshots(
      snapshot,
      remoteVariant,
      state.baselineHashes,
      observedAt,
    );
    const mergedPayload = payloadForContext(merged.snapshot, failure.context);
    if (!mergedPayload) throw new RemoteManifestChangedError();
    const mergedEncoded = await encodeCloudPayload(mergedPayload);
    const preservedMerged = await this.putJson(
      basePayloadName(failure.context),
      parentId,
      mergedEncoded,
      undefined,
      cacheKeyForContext(failure.context),
      state,
      signal,
      failure.reference.fileId,
    );
    const manifestBase = await this.materializeRecoveryManifest(
      current.manifest,
      failure.context,
      preservedMerged.reference,
      state,
      signal,
    );
    const finalSource = await this.loadUnchangedFailedManifest(failure, signal);
    if (finalSource.sourceId !== current.sourceId)
      throw new RemoteManifestChangedError();
    await this.revalidateFailedPayload(failure, signal);
    if (state.dirtyGeneration !== recoveryDirtyGeneration) {
      throw new RemoteManifestChangedError();
    }
    if (!this.rootFolderId) throw new RemoteManifestChangedError();
    const conflicts = mergeConflictEvidence(
      current.manifest.conflicts ?? [],
      state.conflicts,
      merged.conflicts,
    );
    await this.publishManifestGeneration(
      {
        ...manifestBase,
        generatedAt: observedAt,
        generatedBy: state.deviceId,
        conflicts,
        recoveryEvidence: mergeRecoveryEvidence(
          current.manifest.recoveryEvidence ?? [],
          {
            sourceManifestId: current.sourceId,
            logicalType: failure.context.logicalType,
            ...(failure.context.documentId
              ? { documentId: failure.context.documentId }
              : {}),
            expected: preservedExpected.reference,
            observed: preservedRemote.reference,
            merged: preservedMerged.reference,
          },
        ),
      },
      this.rootFolderId,
      signal,
    );
    state.conflicts = conflicts;
    this.clearCachedRemoteAfterRecovery(state);
    return merged.conflicts;
  }

  private async loadUnchangedFailedManifest(
    failure: GoogleDrivePayloadIntegrityError,
    signal: AbortSignal,
  ): Promise<{
    manifest: CloudSyncManifest;
    file: DriveFileMetadata;
    text: string;
    sourceId: string;
  }> {
    if (!this.rootFolderId) throw new RemoteManifestChangedError();
    const immutableFailure = isImmutableCloudManifest(failure.manifest);
    const currentManifestFile = immutableFailure
      ? await this.drive.getMetadata(failure.manifestFile.id, signal)
      : await this.findFile(
          this.rootFolderId,
          LEGACY_MANIFEST_NAME,
          failure.manifestFile.id,
          signal,
          undefined,
          true,
        );
    if (
      !currentManifestFile ||
      currentManifestFile.id !== failure.manifestFile.id ||
      currentManifestFile.trashed ||
      !currentManifestFile.parents?.includes(this.rootFolderId)
    ) {
      throw new RemoteManifestChangedError();
    }
    const text = await this.drive.downloadText(currentManifestFile.id, signal);
    const currentManifest = parseCloudManifest(text);
    if (stableStringify(currentManifest) !== stableStringify(failure.manifest)) {
      throw new RemoteManifestChangedError();
    }
    const currentReference = referenceForContext(currentManifest, failure.context);
    if (
      !currentReference ||
      currentReference.fileId !== failure.reference.fileId ||
      currentReference.sha256 !== failure.reference.sha256
    ) {
      throw new RemoteManifestChangedError();
    }
    const sourceId = isImmutableCloudManifest(currentManifest)
      ? currentManifest.generation.id
      : await legacyManifestSourceId(currentManifestFile.id, text);
    if (failure.manifestSourceId && sourceId !== failure.manifestSourceId) {
      throw new RemoteManifestChangedError();
    }
    if (isImmutableCloudManifest(currentManifest)) {
      if (
        text !== stableStringify(currentManifest) ||
        !(await verifyCloudManifestGeneration(currentManifest)) ||
        !matchesManifestGenerationFile(
          currentManifestFile,
          this.rootFolderId,
          currentManifest,
        )
      ) {
        throw new RemoteManifestChangedError();
      }
      this.lastHeadIds = [currentManifest.generation.id];
      this.lastLegacySourceIds = currentManifest.generation.legacySources;
      this.lastLoadedHeads = [];
      this.lastLegacyEvidence = await this.readLegacyManifestEvidenceAt(
        this.rootFolderId,
        undefined,
        signal,
      );
      if (
        this.lastLegacyEvidence &&
        !this.lastLegacySourceIds.includes(this.lastLegacyEvidence.sourceId)
      ) {
        throw new RemoteManifestChangedError();
      }
    } else {
      this.lastHeadIds = [];
      this.lastLegacySourceIds = [sourceId];
      this.lastLoadedHeads = [];
      this.lastLegacyEvidence = {
        file: currentManifestFile,
        manifest: currentManifest,
        text,
        sourceId,
      };
    }
    this.lastRecoveryEvidence = currentManifest.recoveryEvidence ?? [];
    this.lastRemoteConflicts = currentManifest.conflicts ?? [];
    return {
      manifest: currentManifest,
      file: currentManifestFile,
      text,
      sourceId,
    };
  }

  private async revalidateFailedPayload(
    failure: GoogleDrivePayloadIntegrityError,
    signal: AbortSignal,
  ): Promise<CloudEntityPayload | undefined> {
    let currentFailure: CloudPayloadIntegrityError | undefined;
    try {
      await parseCloudPayloadBlob(
        await this.drive.downloadBlob(failure.reference.fileId, signal),
        failure.expectedHash,
        failure.context,
      );
    } catch (error) {
      if (!(error instanceof CloudPayloadIntegrityError)) throw error;
      currentFailure = error;
    }
    if (
      !currentFailure ||
      currentFailure.actualHash !== failure.actualHash ||
      currentFailure.actualPayloadValid !== Boolean(failure.actualPayload) ||
      (currentFailure.actualPayload &&
        failure.actualPayload &&
        stableStringify(currentFailure.actualPayload) !==
          stableStringify(failure.actualPayload))
    ) {
      throw new RemoteManifestChangedError();
    }
    return currentFailure.actualPayload;
  }

  private async assertRecoveryHasNoPublishedSuccess(
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.rootFolderId) throw new RemoteManifestChangedError();
    if (
      (await this.discoverManifestGenerations(this.rootFolderId, signal)).length > 0
    ) {
      throw new RemoteManifestChangedError();
    }
  }

  private async materializeRecoveryManifest(
    source: CloudSyncManifest,
    replacementContext: CloudPayloadContext,
    replacement: CloudPayloadReference,
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<CloudSyncManifest> {
    if (!this.rootFolderId) throw new RemoteManifestChangedError();
    const copy = async (
      reference: CloudPayloadReference,
      context: CloudPayloadContext,
      parentId: string,
    ): Promise<CloudPayloadReference> => {
      if (samePayloadContext(context, replacementContext)) return replacement;
      const payload = await parseCloudPayloadBlob(
        await this.drive.downloadBlob(reference.fileId, signal),
        reference.sha256,
        context,
      );
      const encoded = await encodeCloudPayload(payload);
      return (
        await this.putJson(
          basePayloadName(context),
          parentId,
          encoded,
          source.payloadStorage === IMMUTABLE_PAYLOAD_STORAGE ? reference : undefined,
          cacheKeyForContext(context),
          state,
          signal,
        )
      ).reference;
    };
    const library = await copy(
      source.library,
      payloadContext('library-metadata'),
      this.rootFolderId,
    );
    const aiSettings = await copy(
      source.aiSettings,
      payloadContext('ai-settings'),
      this.rootFolderId,
    );
    const documents: CloudDocumentManifest[] = [];
    for (const document of source.documents) {
      const stateContext = payloadContext('document-state', document.documentId);
      const productivityContext = payloadContext(
        'productivity-data',
        document.documentId,
      );
      const documentState = await copy(document.state, stateContext, document.folderId);
      const productivity = document.productivity
        ? await copy(document.productivity, productivityContext, document.folderId)
        : undefined;
      if (document.pdf) await this.verifyReferencedPdf(document.pdf, signal);
      documents.push({
        ...document,
        state: documentState,
        ...(productivity ? { productivity } : {}),
      });
    }
    return manifestContent({
      ...source,
      payloadStorage: IMMUTABLE_PAYLOAD_STORAGE,
      library,
      aiSettings,
      documents,
    });
  }

  private async verifyReferencedPdf(
    pdf: CloudDocumentManifest['pdf'],
    signal: AbortSignal,
  ): Promise<void> {
    if (!pdf) return;
    const blob = await this.drive.downloadBlob(pdf.fileId, signal);
    if (blob.size !== pdf.size || (await sha256Hex(blob)) !== pdf.sha256) {
      throw new Error('A referenced Drive PDF failed publication verification.');
    }
  }

  private async requireSelectedResetRoot(
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const rootId = state.driveFiles.rootFolderId;
    if (!rootId) {
      throw new Error('Select an existing 39Note Google Drive folder before reset.');
    }
    let root: DriveFileMetadata;
    try {
      root = await this.drive.getMetadata(rootId, signal);
    } catch (error) {
      if (error instanceof DriveRequestError && error.status === 404) {
        throw new DriveRootUnavailableError();
      }
      throw error;
    }
    if (
      root.id !== rootId ||
      root.mimeType !== FOLDER_MIME ||
      root.trashed ||
      root.appProperties?.application !== '39Note' ||
      root.appProperties.syncSchema !== String(SYNC_SCHEMA_VERSION) ||
      root.appProperties.role !== 'root'
    ) {
      throw new Error(
        '39Note refused to reset because the selected Drive folder identity could not be verified.',
      );
    }
    this.rootFolderId = root.id;
    return root;
  }

  private async discoverResetManagedArtifacts(
    rootId: string,
    signal: AbortSignal,
  ): Promise<ResetManagedArtifacts> {
    const targets: DriveFileMetadata[] = [];
    const documentFolders = new Map<string, DriveFileMetadata>();
    const rootChildren = await this.listVerifiedResetChildren(rootId, signal);
    const documentsFolders = rootChildren.filter(isManagedDocumentsFolder);
    const readmes = rootChildren.filter(isManagedReadme);
    if (
      rootChildren.some(
        (file) =>
          file.name === DOCUMENTS_NAME &&
          file.mimeType === FOLDER_MIME &&
          !isManagedDocumentsFolder(file),
      ) ||
      rootChildren.some((file) => file.name === README_NAME && !isManagedReadme(file))
    ) {
      throw new Error(
        'An unmanaged Drive item uses a reserved 39Note name. Reset was not started.',
      );
    }
    if (documentsFolders.length > 1 || readmes.length > 1) {
      throw new Error(
        'Multiple managed 39Note folder structures were found. Reset was not started.',
      );
    }
    targets.push(...rootChildren.filter(isManagedRootResetArtifact));

    const documentsFolder = documentsFolders[0];
    if (documentsFolder) {
      const documentChildren = await this.listVerifiedResetChildren(
        documentsFolder.id,
        signal,
      );
      if (
        documentChildren.some(
          (file) =>
            file.mimeType === FOLDER_MIME &&
            file.name.startsWith('document-') &&
            !managedDocumentFolderId(file),
        )
      ) {
        throw new Error(
          'An unmanaged Drive folder uses a reserved 39Note document name. Reset was not started.',
        );
      }
      for (const folder of documentChildren) {
        const documentId = managedDocumentFolderId(folder);
        if (!documentId) continue;
        if (documentFolders.has(documentId)) {
          throw new Error(
            `Multiple managed Drive folders were found for document ${documentId}. Reset was not started.`,
          );
        }
        documentFolders.set(documentId, folder);
        const payloads = await this.listVerifiedResetChildren(folder.id, signal);
        targets.push(
          ...payloads.filter((file) =>
            isManagedDocumentResetArtifact(file, documentId),
          ),
        );
      }
    }

    targets.sort((first, second) => {
      const roleOrder = (file: DriveFileMetadata) =>
        file.appProperties?.role === 'manifest' ||
        file.appProperties?.role === 'manifest-generation'
          ? 0
          : 1;
      return (
        roleOrder(first) - roleOrder(second) ||
        compareCanonicalStrings(first.id, second.id)
      );
    });
    return {
      targets,
      ...(documentsFolder ? { documentsFolder } : {}),
      documentFolders,
      ...(readmes[0] ? { readme: readmes[0] } : {}),
    };
  }

  private async listVerifiedResetChildren(
    parentId: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata[]> {
    const query = [
      `'${escapeDriveQueryValue(parentId)}' in parents`,
      'trashed=false',
    ].join(' and ');
    const children: DriveFileMetadata[] = [];
    for (const listed of dedupeDriveFiles(await this.drive.listFiles(query, signal))) {
      let current: DriveFileMetadata;
      try {
        current = await this.drive.getMetadata(listed.id, signal);
      } catch (error) {
        if (error instanceof DriveRequestError && error.status === 404) continue;
        throw error;
      }
      if (current.trashed || !current.parents?.includes(parentId)) continue;
      if (
        isKnownManagedRole(current) &&
        (current.parents.length !== 1 || current.parents[0] !== parentId)
      ) {
        throw new Error(
          'A managed Drive item has ambiguous folder ancestry. Reset was not started.',
        );
      }
      children.push(current);
    }
    return children;
  }

  private clearRemoteCachesForReset(
    state: SyncDeviceState,
    rootId: string,
    preflight: ResetManagedArtifacts,
  ): void {
    const fileIds: Record<string, string> = {};
    if (preflight.documentsFolder) {
      fileIds['documents-folder'] = preflight.documentsFolder.id;
    }
    for (const [documentId, folder] of preflight.documentFolders) {
      fileIds[`document-folder:${documentId}`] = folder.id;
    }
    state.driveFiles = {
      rootFolderId: rootId,
      ...(preflight.readme ? { readmeFileId: preflight.readme.id } : {}),
      ...(preflight.documentsFolder
        ? { documentsFolderId: preflight.documentsFolder.id }
        : {}),
      fileIds,
    };
    delete state.remoteManifestVersion;
    delete state.remoteManifest;
    delete state.remoteSnapshot;
    this.rootFolderId = rootId;
    this.lastManifest = null;
    this.lastHeadIds = [];
    this.lastLegacySourceIds = [];
    this.lastLoadedHeads = [];
    this.lastLegacyEvidence = null;
    this.lastRecoveryEvidence = [];
    this.lastRemoteConflicts = [];
  }

  private clearCachedRemoteAfterRecovery(state: SyncDeviceState): void {
    delete state.remoteManifestVersion;
    delete state.remoteManifest;
    delete state.remoteSnapshot;
  }

  private async ensureFolder(
    name: string,
    parentId: string,
    appProperties: Record<string, string>,
    cacheKey: string,
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const existing = await this.findFile(
      parentId,
      name,
      state.driveFiles.fileIds[cacheKey],
      signal,
      FOLDER_MIME,
    );
    if (existing) {
      state.driveFiles.fileIds[cacheKey] = existing.id;
      return existing;
    }
    const created = await this.drive.createFolder(
      name,
      parentId,
      appProperties,
      signal,
    );
    state.driveFiles.fileIds[cacheKey] = created.id;
    return created;
  }

  private async ensureReadme(
    rootId: string,
    state: SyncDeviceState,
    signal: AbortSignal,
  ): Promise<boolean> {
    const existing = await this.findFile(
      rootId,
      README_NAME,
      state.driveFiles.readmeFileId,
      signal,
    );
    if (existing) {
      state.driveFiles.readmeFileId = existing.id;
      return false;
    }
    const content = new Blob(
      [
        '39Note Google Drive Sync\n\n',
        'This visible folder contains versioned, app-created sync data and original PDF files.\n',
        'Edit your notes in 39Note, not directly in these JSON files. Malformed or newer-version data is rejected.\n',
        'AI API keys, Google OAuth tokens, passwords, client secrets, and custom authentication headers are never included.\n',
        `Sync schema version: ${SYNC_SCHEMA_VERSION}\n`,
      ],
      { type: 'text/plain' },
    );
    const created = await this.drive.uploadFile(
      README_NAME,
      content,
      {
        parents: [rootId],
        appProperties: { ...APP_PROPERTIES, role: 'readme' },
      },
      signal,
    );
    state.driveFiles.readmeFileId = created.id;
    return true;
  }

  private async putJson(
    name: string,
    parentId: string,
    encoded: { text: string; sha256: string },
    prior: CloudPayloadReference | undefined,
    cacheKey: string,
    state: SyncDeviceState,
    signal: AbortSignal,
    excludedFileId?: string,
  ): Promise<{ reference: CloudPayloadReference; changed: boolean }> {
    if (prior?.sha256 === encoded.sha256) {
      state.driveFiles.fileIds[cacheKey] = prior.fileId;
      return { reference: prior, changed: false };
    }
    const content = new Blob([encoded.text], { type: 'application/json' });
    const generationName = payloadGenerationName(name, encoded.sha256);
    const reusableGeneration = await this.findReusablePayloadGeneration(
      parentId,
      generationName,
      state.driveFiles.fileIds[cacheKey],
      encoded.sha256,
      contextForCacheKey(cacheKey),
      excludedFileId,
      signal,
    );
    const file =
      reusableGeneration ??
      (await this.drive.uploadFile(
        generationName,
        content,
        {
          parents: [parentId],
          appProperties: {
            ...APP_PROPERTIES,
            role: cacheKey.split(':')[0],
            sha256: encoded.sha256,
          },
        },
        signal,
      ));
    try {
      await parseCloudPayloadBlob(
        await this.drive.downloadBlob(file.id, signal),
        encoded.sha256,
        contextForCacheKey(cacheKey),
      );
    } catch (error) {
      if (error instanceof CloudPayloadIntegrityError) {
        throw new Error(
          'Google Drive upload verification failed. The manifest was not published.',
          { cause: error },
        );
      }
      throw error;
    }
    state.driveFiles.fileIds[cacheKey] = file.id;
    return {
      reference: { fileId: file.id, sha256: encoded.sha256 },
      changed: !reusableGeneration,
    };
  }

  private async findReusablePayloadGeneration(
    parentId: string,
    name: string,
    cachedId: string | undefined,
    expectedHash: string,
    context: CloudPayloadContext,
    excludedFileId: string | undefined,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata | null> {
    const candidates = new Map<string, DriveFileMetadata>();
    if (cachedId && cachedId !== excludedFileId) {
      try {
        const cached = await this.drive.getMetadata(cachedId, signal);
        if (matchesExpectedFile(cached, parentId, name))
          candidates.set(cached.id, cached);
      } catch (error) {
        if (!(error instanceof DriveRequestError) || error.status !== 404) throw error;
      }
    }
    const query = [
      `'${escapeDriveQueryValue(parentId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
    ].join(' and ');
    for (const file of await this.drive.listFiles(query, signal)) {
      if (
        file.id !== excludedFileId &&
        matchesExpectedFile(file, parentId, name) &&
        file.appProperties?.sha256 === expectedHash
      ) {
        candidates.set(file.id, file);
      }
    }
    for (const candidate of [...candidates.values()].sort((first, second) =>
      compareCanonicalStrings(first.id, second.id),
    )) {
      try {
        await parseCloudPayloadBlob(
          await this.drive.downloadBlob(candidate.id, signal),
          expectedHash,
          context,
        );
        return candidate;
      } catch (error) {
        if (error instanceof DriveRequestError && error.status === 404) continue;
        if (error instanceof CloudPayloadIntegrityError) continue;
        throw error;
      }
    }
    return null;
  }

  private async findFile(
    parentId: string,
    name: string,
    cachedId: string | undefined,
    signal: AbortSignal,
    mimeType?: string,
    mustCheckDuplicates = false,
  ): Promise<DriveFileMetadata | null> {
    let cachedMatch: DriveFileMetadata | null = null;
    if (cachedId) {
      try {
        const file = await this.drive.getMetadata(cachedId, signal);
        if (matchesExpectedFile(file, parentId, name, mimeType)) {
          if (!mustCheckDuplicates) return file;
          cachedMatch = file;
        }
      } catch (error) {
        if (!(error instanceof DriveRequestError) || error.status !== 404) throw error;
      }
    }
    const query = [
      `'${escapeDriveQueryValue(parentId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
      ...(mimeType ? [`mimeType='${escapeDriveQueryValue(mimeType)}'`] : []),
    ].join(' and ');
    const matches = await this.drive.listFiles(query, signal);
    if (matches.length > 1) {
      throw new Error(
        `Multiple app-created Drive items named ${name} were found in the same folder.`,
      );
    }
    if (cachedMatch && matches.length === 1 && matches[0].id !== cachedMatch.id) {
      throw new Error(
        `Multiple app-created Drive items named ${name} were found in the same folder.`,
      );
    }
    const selected = matches[0] ?? cachedMatch;
    if (!selected || !mustCheckDuplicates) return selected;
    try {
      const refreshed = await this.drive.getMetadata(selected.id, signal);
      if (!matchesExpectedFile(refreshed, parentId, name, mimeType)) {
        if (refreshed.trashed || !refreshed.parents?.includes(parentId)) return null;
        throw new RemoteManifestChangedError();
      }
      return refreshed;
    } catch (error) {
      if (error instanceof DriveRequestError && error.status === 404) {
        throw new RemoteManifestChangedError();
      }
      throw error;
    }
  }
}

function dedupeDriveFiles(files: readonly DriveFileMetadata[]): DriveFileMetadata[] {
  return [...new Map(files.map((file) => [file.id, file])).values()];
}

function dedupeManifestGenerations(
  generations: readonly LoadedManifestGeneration[],
): LoadedManifestGeneration[] {
  const logical = new Map<string, LoadedManifestGeneration>();
  for (const generation of generations) {
    const id = generation.manifest.generation.id;
    const existing = logical.get(id);
    if (
      existing &&
      stableStringify(existing.manifest) !== stableStringify(generation.manifest)
    ) {
      throw new Error('Conflicting immutable Drive manifest identities were found.');
    }
    if (
      !existing ||
      compareCanonicalStrings(generation.file.id, existing.file.id) < 0
    ) {
      logical.set(id, generation);
    }
  }
  return [...logical.values()];
}

function deriveManifestHeads(
  generations: readonly LoadedManifestGeneration[],
): LoadedManifestGeneration[] {
  const parentIds = new Set(
    generations.flatMap((generation) => generation.manifest.generation.parents),
  );
  return generations
    .filter((generation) => !parentIds.has(generation.manifest.generation.id))
    .sort((first, second) =>
      compareCanonicalStrings(
        first.manifest.generation.id,
        second.manifest.generation.id,
      ),
    );
}

function foldManifestHeads(heads: readonly LoadedManifestGeneration[]): {
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
} {
  if (heads.length === 0) throw new Error('No valid immutable Drive head was found.');
  const ordered = [...heads].sort((first, second) =>
    compareCanonicalStrings(
      first.manifest.generation.id,
      second.manifest.generation.id,
    ),
  );
  const observedAt = Math.max(
    ...ordered.map((head) =>
      Math.max(head.snapshot.generatedAt, head.manifest.generation.createdAt),
    ),
  );
  let snapshot = ordered[0].snapshot;
  let conflicts = mergeConflictEvidence([], ordered[0].manifest.conflicts);
  for (const head of ordered.slice(1)) {
    const merged = mergeSyncSnapshots(snapshot, head.snapshot, {}, observedAt);
    snapshot = merged.snapshot;
    conflicts = mergeConflictEvidence(
      conflicts,
      head.manifest.conflicts,
      merged.conflicts,
    );
  }
  return { snapshot, conflicts };
}

function manifestGenerationSubsumes(
  child: LoadedManifestGeneration,
  parent: LoadedManifestGeneration,
): boolean {
  if (
    !parent.manifest.generation.legacySources.every((source) =>
      child.manifest.generation.legacySources.includes(source),
    )
  ) {
    return false;
  }
  if (
    parent.manifest.conflicts.some(
      (conflict) =>
        !child.manifest.conflicts.some((candidate) =>
          conflictEvidenceSubsumes(candidate, conflict),
        ),
    )
  ) {
    return false;
  }
  const childRecoveryKeys = new Set(
    (child.manifest.recoveryEvidence ?? []).map((item) => stableStringify(item)),
  );
  if (
    (parent.manifest.recoveryEvidence ?? []).some(
      (item) => !childRecoveryKeys.has(stableStringify(item)),
    )
  ) {
    return false;
  }
  try {
    const merged = mergeSyncSnapshots(
      parent.snapshot,
      child.snapshot,
      {},
      Math.max(parent.snapshot.generatedAt, child.snapshot.generatedAt),
    );
    return (
      snapshotContent(merged.snapshot) === snapshotContent(child.snapshot) &&
      (child.manifest.generation.parents.length === 1 ||
        merged.conflicts.every((conflict) =>
          child.manifest.conflicts.some((candidate) =>
            conflictEvidenceSubsumes(candidate, conflict),
          ),
        ))
    );
  } catch {
    return false;
  }
}

function manifestRecoveryPreservesParent(
  parent: ImmutableCloudSyncManifest,
  child: ImmutableCloudSyncManifest,
  replacementContext: CloudPayloadContext,
): boolean {
  if (
    !parent.generation.legacySources.every((source) =>
      child.generation.legacySources.includes(source),
    ) ||
    parent.conflicts.some(
      (conflict) =>
        !child.conflicts.some((candidate) =>
          conflictEvidenceSubsumes(candidate, conflict),
        ),
    )
  ) {
    return false;
  }
  const childRecoveryEvidence = new Set(
    (child.recoveryEvidence ?? []).map((item) => stableStringify(item)),
  );
  if (
    (parent.recoveryEvidence ?? []).some(
      (item) => !childRecoveryEvidence.has(stableStringify(item)),
    )
  ) {
    return false;
  }

  const parentDocuments = [...parent.documents].sort((first, second) =>
    compareCanonicalStrings(first.documentId, second.documentId),
  );
  const childDocuments = [...child.documents].sort((first, second) =>
    compareCanonicalStrings(first.documentId, second.documentId),
  );
  if (parentDocuments.length !== childDocuments.length) return false;
  for (let index = 0; index < parentDocuments.length; index += 1) {
    const parentDocument = parentDocuments[index];
    const childDocument = childDocuments[index];
    if (
      parentDocument.documentId !== childDocument.documentId ||
      parentDocument.folderId !== childDocument.folderId ||
      Boolean(parentDocument.productivity) !== Boolean(childDocument.productivity) ||
      stableStringify(parentDocument.pdf) !== stableStringify(childDocument.pdf)
    ) {
      return false;
    }
  }

  const contexts: CloudPayloadContext[] = [
    payloadContext('library-metadata'),
    payloadContext('ai-settings'),
    ...parentDocuments.flatMap((document) => [
      payloadContext('document-state', document.documentId),
      ...(document.productivity
        ? [payloadContext('productivity-data', document.documentId)]
        : []),
    ]),
  ];
  return contexts.every((context) => {
    if (samePayloadContext(context, replacementContext)) return true;
    return (
      stableStringify(referenceForContext(parent, context)) ===
      stableStringify(referenceForContext(child, context))
    );
  });
}

function conflictEvidenceSubsumes(child: SyncConflict, parent: SyncConflict): boolean {
  if (conflictEvidenceKey(child) !== conflictEvidenceKey(parent)) return false;
  return (
    stableStringify(persistedConflictEvidence(child)) ===
      stableStringify(persistedConflictEvidence(parent)) &&
    (parent.dismissedAt === undefined ||
      (child.dismissedAt !== undefined && child.dismissedAt >= parent.dismissedAt))
  );
}

function persistedConflictEvidence(conflict: SyncConflict): object {
  return {
    entityKey: conflict.entityKey,
    entityKind: conflict.entityKind,
    ...(conflict.documentId ? { documentId: conflict.documentId } : {}),
    detectedAt: conflict.detectedAt,
    winningVersion: conflict.winningVersion,
    alternateVersion: conflict.alternateVersion,
    winningValue: conflict.winningValue,
    alternateValue: conflict.alternateValue,
  };
}

function mergeConflictEvidence(
  ...journals: ReadonlyArray<readonly SyncConflict[]>
): SyncConflict[] {
  const byEvidence = new Map<string, SyncConflict>();
  for (const conflict of journals.flat()) {
    const key = conflictEvidenceKey(conflict);
    const existing = byEvidence.get(key);
    if (!existing) {
      byEvidence.set(key, conflict);
      continue;
    }
    byEvidence.set(key, {
      ...(compareCanonicalStrings(existing.id, conflict.id) <= 0 ? existing : conflict),
      ...(existing.dismissedAt !== undefined || conflict.dismissedAt !== undefined
        ? {
            dismissedAt: Math.max(existing.dismissedAt ?? 0, conflict.dismissedAt ?? 0),
          }
        : {}),
    });
  }
  return [...byEvidence.values()].sort((first, second) =>
    compareCanonicalStrings(conflictEvidenceKey(first), conflictEvidenceKey(second)),
  );
}

function conflictEvidenceKey(conflict: SyncConflict): string {
  return stableStringify({
    entityKey: conflict.entityKey,
    winningHash: conflict.winningVersion.hash,
    alternateHash: conflict.alternateVersion.hash,
  });
}

function snapshotContent(snapshot: SyncSnapshot): string {
  return stableStringify({
    entities: [...snapshot.entities].sort((first, second) =>
      compareCanonicalStrings(first.key, second.key),
    ),
    tombstones: [...snapshot.tombstones].sort((first, second) =>
      compareCanonicalStrings(first.key, second.key),
    ),
    pdfs: [...snapshot.pdfs].sort((first, second) =>
      compareCanonicalStrings(first.documentId, second.documentId),
    ),
  });
}

function cloudPayloadContent(payload: CloudEntityPayload): string {
  return stableStringify({
    app: payload.app,
    syncSchemaVersion: payload.syncSchemaVersion,
    entities: [...payload.entities].sort((first, second) =>
      compareCanonicalStrings(first.key, second.key),
    ),
    tombstones: [...payload.tombstones].sort((first, second) =>
      compareCanonicalStrings(first.key, second.key),
    ),
  });
}

function manifestParentEdge(childId: string, parentId: string): string {
  return `${childId}:${parentId}`;
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

function mergeRecoveryEvidence(
  existing: readonly CloudManifestRecoveryEvidence[],
  incoming: CloudManifestRecoveryEvidence,
): CloudManifestRecoveryEvidence[] {
  return mergeRecoveryEvidenceList([...existing, incoming]);
}

function mergeRecoveryEvidenceList(
  evidence: readonly CloudManifestRecoveryEvidence[],
): CloudManifestRecoveryEvidence[] {
  return [
    ...new Map(evidence.map((item) => [stableStringify(item), item])).values(),
  ].sort((first, second) =>
    compareCanonicalStrings(stableStringify(first), stableStringify(second)),
  );
}

function samePayloadContext(
  first: CloudPayloadContext,
  second: CloudPayloadContext,
): boolean {
  return (
    first.logicalType === second.logicalType && first.documentId === second.documentId
  );
}

function manifestContent(manifest: CloudSyncManifest): CloudSyncManifest {
  return {
    app: manifest.app,
    syncSchemaVersion: manifest.syncSchemaVersion,
    generatedAt: manifest.generatedAt,
    generatedBy: manifest.generatedBy,
    ...(manifest.payloadStorage ? { payloadStorage: manifest.payloadStorage } : {}),
    ...(manifest.conflicts ? { conflicts: manifest.conflicts } : {}),
    ...(manifest.recoveryEvidence
      ? { recoveryEvidence: manifest.recoveryEvidence }
      : {}),
    library: manifest.library,
    aiSettings: manifest.aiSettings,
    documents: manifest.documents,
  };
}

async function manifestHeadSetId(headIds: readonly string[]): Promise<string> {
  return headIds.length === 1
    ? headIds[0]
    : sha256Hex(stableStringify({ manifestHeads: [...headIds].sort() }));
}

async function legacyManifestSourceId(fileId: string, text: string): Promise<string> {
  return sha256Hex(stableStringify({ fileId, manifestSha256: await sha256Hex(text) }));
}

function manifestGenerationName(generationId: string): string {
  return `${MANIFEST_GENERATION_PREFIX}${generationId}.json`;
}

function matchesManifestGenerationFile(
  file: DriveFileMetadata,
  rootId: string,
  manifest: ImmutableCloudSyncManifest,
): boolean {
  return (
    matchesExpectedFile(file, rootId, manifestGenerationName(manifest.generation.id)) &&
    file.appProperties?.application === '39Note' &&
    file.appProperties.role === 'manifest-generation' &&
    file.appProperties.manifestStorage === IMMUTABLE_MANIFEST_STORAGE &&
    file.appProperties.generationId === manifest.generation.id
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalStrings);
}

function emptySnapshot(deviceId: string): SyncSnapshot {
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: 0,
    generatedBy: deviceId,
    entities: [],
    tombstones: [],
    pdfs: [],
  };
}

function matchesExpectedFile(
  file: DriveFileMetadata,
  parentId: string,
  name: string,
  mimeType?: string,
): boolean {
  return (
    !file.trashed &&
    file.name === name &&
    Boolean(file.parents?.includes(parentId)) &&
    (!mimeType || file.mimeType === mimeType)
  );
}

function isKnownManagedRole(file: DriveFileMetadata): boolean {
  return (
    file.appProperties?.application === '39Note' &&
    file.appProperties.syncSchema === String(SYNC_SCHEMA_VERSION) &&
    [
      'root',
      'readme',
      'documents',
      'document',
      'manifest',
      'manifest-generation',
      'library',
      'ai-settings',
      'state',
      'productivity',
      'original-pdf',
    ].includes(file.appProperties.role)
  );
}

function hasManagedRole(file: DriveFileMetadata, role: string): boolean {
  return isKnownManagedRole(file) && file.appProperties?.role === role;
}

function isManagedReadme(file: DriveFileMetadata): boolean {
  return (
    hasManagedRole(file, 'readme') &&
    file.name === README_NAME &&
    file.mimeType === 'text/plain'
  );
}

function isManagedDocumentsFolder(file: DriveFileMetadata): boolean {
  return (
    hasManagedRole(file, 'documents') &&
    file.name === DOCUMENTS_NAME &&
    file.mimeType === FOLDER_MIME
  );
}

function managedDocumentFolderId(file: DriveFileMetadata): string | null {
  const documentId = file.appProperties?.documentId;
  if (
    !documentId ||
    !hasManagedRole(file, 'document') ||
    file.mimeType !== FOLDER_MIME ||
    file.name !== documentFolderName(documentId)
  ) {
    return null;
  }
  return documentId;
}

function isManagedRootResetArtifact(file: DriveFileMetadata): boolean {
  if (file.mimeType !== 'application/json') return false;
  const role = file.appProperties?.role;
  if (role === 'manifest' && hasManagedRole(file, role)) {
    return file.name === LEGACY_MANIFEST_NAME;
  }
  if (role === 'manifest-generation' && hasManagedRole(file, role)) {
    const generationId = file.appProperties?.generationId;
    return (
      file.appProperties?.manifestStorage === IMMUTABLE_MANIFEST_STORAGE &&
      typeof generationId === 'string' &&
      /^[a-f0-9]{64}$/u.test(generationId) &&
      file.name === manifestGenerationName(generationId)
    );
  }
  if (role === 'library' && hasManagedRole(file, role)) {
    return isManagedJsonPayloadName(file, LIBRARY_NAME);
  }
  if (role === 'ai-settings' && hasManagedRole(file, role)) {
    return isManagedJsonPayloadName(file, AI_SETTINGS_NAME);
  }
  return false;
}

function isManagedDocumentResetArtifact(
  file: DriveFileMetadata,
  documentId: string,
): boolean {
  const role = file.appProperties?.role;
  if (
    file.mimeType === 'application/json' &&
    role === 'state' &&
    hasManagedRole(file, role)
  ) {
    return isManagedJsonPayloadName(file, STATE_NAME);
  }
  if (
    file.mimeType === 'application/json' &&
    role === 'productivity' &&
    hasManagedRole(file, role)
  ) {
    return isManagedJsonPayloadName(file, PRODUCTIVITY_NAME);
  }
  if (
    (file.mimeType === 'application/pdf' ||
      file.mimeType === 'application/octet-stream') &&
    role === 'original-pdf' &&
    hasManagedRole(file, role)
  ) {
    const sha256 = file.appProperties?.sha256;
    return (
      file.appProperties?.documentId === documentId &&
      typeof sha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(sha256) &&
      (file.name === 'original.pdf' || file.name === pdfGenerationName(sha256))
    );
  }
  return false;
}

function isManagedJsonPayloadName(file: DriveFileMetadata, baseName: string): boolean {
  if (file.name === baseName) return true;
  const sha256 = file.appProperties?.sha256;
  return (
    typeof sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(sha256) &&
    file.name === payloadGenerationName(baseName, sha256)
  );
}

function sameResetCandidate(
  expected: DriveFileMetadata,
  current: DriveFileMetadata,
): boolean {
  const identity = (file: DriveFileMetadata) =>
    stableStringify({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: [...(file.parents ?? [])].sort(compareCanonicalStrings),
      appProperties: file.appProperties ?? {},
      modifiedTime: file.modifiedTime ?? null,
      version: file.version ?? null,
      size: file.size ?? null,
      trashed: file.trashed === true,
    });
  return !current.trashed && identity(expected) === identity(current);
}

function sameResetFolderLayout(
  expected: ResetManagedArtifacts,
  current: ResetManagedArtifacts,
): boolean {
  if (expected.documentsFolder?.id !== current.documentsFolder?.id) return false;
  if (expected.readme?.id !== current.readme?.id) return false;
  if (expected.documentFolders.size !== current.documentFolders.size) return false;
  for (const [documentId, folder] of expected.documentFolders) {
    if (current.documentFolders.get(documentId)?.id !== folder.id) return false;
  }
  return true;
}

function snapshotWithoutDrivePdfIds(snapshot: SyncSnapshot): SyncSnapshot {
  return {
    ...snapshot,
    pdfs: snapshot.pdfs.map(withoutDrivePdfId),
  };
}

function withoutDrivePdfId<T extends SyncPdfDescriptor>(pdf: T): T {
  const withoutFileId = { ...pdf };
  delete withoutFileId.fileId;
  return withoutFileId;
}

async function validateResetSource(
  snapshot: SyncSnapshot,
  localPdfs: readonly LocalSyncPdf[],
): Promise<void> {
  assertNoSecretsInSyncPayload(snapshot);
  if (snapshot.app !== '39Note' || snapshot.syncSchemaVersion !== SYNC_SCHEMA_VERSION) {
    throw new Error('The local sync snapshot is not a supported 39Note generation.');
  }
  const entityKeys = new Set<string>();
  for (const entity of snapshot.entities) {
    if (!entity.key || entityKeys.has(entity.key)) {
      throw new Error('The local sync snapshot contains duplicate entity identities.');
    }
    entityKeys.add(entity.key);
  }
  const tombstoneKeys = new Set<string>();
  for (const tombstone of snapshot.tombstones) {
    if (
      !tombstone.key ||
      tombstoneKeys.has(tombstone.key) ||
      entityKeys.has(tombstone.key)
    ) {
      throw new Error('The local sync snapshot contains an invalid tombstone set.');
    }
    tombstoneKeys.add(tombstone.key);
  }
  const descriptors = new Map<string, SyncPdfDescriptor>();
  for (const descriptor of snapshot.pdfs) {
    if (
      !descriptor.documentId ||
      descriptors.has(descriptor.documentId) ||
      !/^[a-f0-9]{64}$/u.test(descriptor.sha256)
    ) {
      throw new Error('The local sync snapshot contains invalid PDF descriptors.');
    }
    descriptors.set(descriptor.documentId, descriptor);
  }
  const localByDocument = new Map<string, LocalSyncPdf>();
  for (const pdf of localPdfs) {
    if (localByDocument.has(pdf.documentId)) {
      throw new Error('The local reset source contains duplicate original PDFs.');
    }
    localByDocument.set(pdf.documentId, pdf);
  }
  if (localByDocument.size !== descriptors.size) {
    throw new Error('Every local PDF descriptor must have one verified original PDF.');
  }
  for (const [documentId, descriptor] of descriptors) {
    const pdf = localByDocument.get(documentId);
    if (
      !pdf ||
      pdf.fileName !== descriptor.fileName ||
      pdf.mimeType !== descriptor.mimeType ||
      pdf.size !== descriptor.size ||
      pdf.lastModified !== descriptor.lastModified ||
      pdf.storedAt !== descriptor.storedAt ||
      pdf.sha256 !== descriptor.sha256 ||
      pdf.blob.size !== descriptor.size ||
      (await sha256Hex(pdf.blob)) !== descriptor.sha256
    ) {
      throw new Error(`The local original PDF ${documentId} failed reset validation.`);
    }
  }
}

function canonicalResetSnapshot(snapshot: SyncSnapshot): string {
  return stableStringify({
    ...snapshot,
    entities: [...snapshot.entities].sort((first, second) =>
      compareCanonicalStrings(first.key, second.key),
    ),
    tombstones: [...snapshot.tombstones].sort((first, second) =>
      compareCanonicalStrings(first.key, second.key),
    ),
    pdfs: [...snapshot.pdfs].sort((first, second) =>
      compareCanonicalStrings(first.documentId, second.documentId),
    ),
  });
}

function documentFolderName(documentId: string): string {
  return `document-${documentId.replace(/[^a-z0-9._-]/giu, '_').slice(0, 96)}`;
}

function sameIntegrityEvidence(
  first: GoogleDrivePayloadIntegrityError,
  second: GoogleDrivePayloadIntegrityError,
): boolean {
  return (
    first.manifestFile.id === second.manifestFile.id &&
    first.manifestFile.version === second.manifestFile.version &&
    first.context.logicalType === second.context.logicalType &&
    first.context.documentId === second.context.documentId &&
    first.reference.fileId === second.reference.fileId &&
    first.reference.sha256 === second.reference.sha256 &&
    first.actualHash === second.actualHash
  );
}

function changedIntegrityDiagnostic(
  diagnostic: SyncIntegrityIssue,
): SyncIntegrityIssue {
  return {
    ...diagnostic,
    retryOutcome: 'changed-during-retry',
    evidenceStable: false,
    validAlternateGenerationAvailable: false,
    localPayloadSemanticallyValid: false,
    remotePayloadSemanticallyValid: false,
    recommendedRecoveryChoices: ['manual-inspection'],
    localRepairAvailable: false,
    remoteMergeAvailable: false,
  };
}

function safeDriveFileVersion(value: string | undefined): string | undefined {
  return value && /^[a-z0-9._-]{1,64}$/iu.test(value) ? value : undefined;
}

function sameDriveVersion(
  first: string | undefined,
  second: string | undefined,
): boolean {
  return first !== undefined && second !== undefined && first === second;
}

function payloadContext(
  logicalType: CloudPayloadContext['logicalType'],
  documentId?: string,
): CloudPayloadContext {
  const logicalPath =
    logicalType === 'library-metadata'
      ? `/${ROOT_NAME}/${LIBRARY_NAME}`
      : logicalType === 'ai-settings'
        ? `/${ROOT_NAME}/${AI_SETTINGS_NAME}`
        : `/${ROOT_NAME}/${DOCUMENTS_NAME}/${documentFolderName(documentId ?? 'unknown')}/${
            logicalType === 'document-state' ? STATE_NAME : PRODUCTIVITY_NAME
          }`;
  return { logicalType, logicalPath, ...(documentId ? { documentId } : {}) };
}

function contextForCacheKey(cacheKey: string): CloudPayloadContext {
  if (cacheKey === 'library') return payloadContext('library-metadata');
  if (cacheKey === 'ai-settings') return payloadContext('ai-settings');
  const separator = cacheKey.indexOf(':');
  const role = separator >= 0 ? cacheKey.slice(0, separator) : cacheKey;
  const documentId = separator >= 0 ? cacheKey.slice(separator + 1) : undefined;
  return payloadContext(
    role === 'state' ? 'document-state' : 'productivity-data',
    documentId,
  );
}

function cacheKeyForContext(context: CloudPayloadContext): string {
  if (context.logicalType === 'library-metadata') return 'library';
  if (context.logicalType === 'ai-settings') return 'ai-settings';
  return `${context.logicalType === 'document-state' ? 'state' : 'productivity'}:${
    context.documentId ?? ''
  }`;
}

function basePayloadName(context: CloudPayloadContext): string {
  if (context.logicalType === 'library-metadata') return LIBRARY_NAME;
  if (context.logicalType === 'ai-settings') return AI_SETTINGS_NAME;
  return context.logicalType === 'document-state' ? STATE_NAME : PRODUCTIVITY_NAME;
}

function payloadGenerationName(baseName: string, sha256: string): string {
  const extension = baseName.endsWith('.json') ? '.json' : '';
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  return `${stem}-${sha256.slice(0, 16)}${extension}`;
}

function pdfGenerationName(sha256: string): string {
  return `original-${sha256.slice(0, 16)}.pdf`;
}

function referenceForContext(
  manifest: CloudSyncManifest,
  context: CloudPayloadContext,
): CloudPayloadReference | undefined {
  if (context.logicalType === 'library-metadata') return manifest.library;
  if (context.logicalType === 'ai-settings') return manifest.aiSettings;
  const document = manifest.documents.find(
    (item) => item.documentId === context.documentId,
  );
  return context.logicalType === 'document-state'
    ? document?.state
    : document?.productivity;
}

function parentIdForContext(
  manifest: CloudSyncManifest,
  context: CloudPayloadContext,
  rootFolderId: string | null,
): string {
  if (
    context.logicalType === 'library-metadata' ||
    context.logicalType === 'ai-settings'
  ) {
    if (!rootFolderId) throw new DriveRootUnavailableError();
    return rootFolderId;
  }
  const folderId = manifest.documents.find(
    (document) => document.documentId === context.documentId,
  )?.folderId;
  if (!folderId) throw new Error('The affected Drive document folder is unavailable.');
  return folderId;
}
