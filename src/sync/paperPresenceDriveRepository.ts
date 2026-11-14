import {
  DriveClient,
  escapeDriveQueryValue,
  type DriveFileMetadata,
} from './driveClient.ts';
import { isValidDocumentId } from '../utils/documentId.ts';
import {
  compareCanonicalStrings,
  isSha256,
  sha256Hex,
  stableStringify,
} from './hash.ts';
import {
  PAPER_PRESENCE_PROTOCOL_VERSION,
  PAPER_PRESENCE_ROLE,
  PAPER_PROTOCOL_MIGRATION_ROLE,
  PAPER_V3_CONTROL_NAME,
  PAPER_V3_CONTROL_ROLE,
  PAPER_V3_DESCRIPTOR_ROLE,
  PAPER_V3_MIGRATION_ROLE,
  createPaperPresenceGeneration,
  inspectPaperPresenceAncestry,
  parsePaperPresenceGeneration,
  verifyPaperPresenceGeneration,
  PaperPresenceIntegrityError,
  type PaperPresenceAncestryDiagnostic,
  type PaperPresenceAncestryFailureCode,
  type PaperPresenceGeneration,
  type PaperPresenceIntent,
  type PaperPresenceState,
  type PaperPresenceWriter,
  type ResolvedPaperPresence,
} from './paperPresence.ts';
import {
  LEGACY_PAPER_SYNC_PROTOCOL_VERSION,
  PAPER_SYNC_PROTOCOL_VERSION,
  SYNC_LAYOUT_VERSION,
  type SupportedPaperSyncProtocolVersion,
} from './paperTypes.ts';
import { PAPER_METADATA_CONCURRENCY, mapWithConcurrency } from './syncConcurrency.ts';
import type { PaperVerificationCacheEntry } from './paperVerificationCache.ts';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface PaperV3LayoutDescriptor {
  app: '39Note';
  kind: 'paper-v3-layout';
  syncLayoutVersion: typeof SYNC_LAYOUT_VERSION;
  paperSyncProtocolVersion: SupportedPaperSyncProtocolVersion;
  presenceProtocolVersion: typeof PAPER_PRESENCE_PROTOCOL_VERSION;
  rootFolderId: string;
  controlFolderId: string;
}

export interface PaperV3MigrationCompletion {
  app: '39Note';
  kind: 'paper-v3-migration-completion';
  syncLayoutVersion: typeof SYNC_LAYOUT_VERSION;
  paperSyncProtocolVersion: SupportedPaperSyncProtocolVersion;
  presenceProtocolVersion: typeof PAPER_PRESENCE_PROTOCOL_VERSION;
  rootFolderId: string;
  controlFolderId: string;
  sourceLayoutVersion: 0 | 2;
  presenceGenerations: Record<
    string,
    {
      generationId: string;
      paperFolderId: string;
      state: PaperPresenceState;
    }
  >;
  createdBy: string;
  id: string;
}

export interface PaperProtocolMigrationCompletion {
  app: '39Note';
  kind: 'paper-protocol-migration-completion';
  syncLayoutVersion: typeof SYNC_LAYOUT_VERSION;
  sourcePaperSyncProtocolVersion: typeof LEGACY_PAPER_SYNC_PROTOCOL_VERSION;
  targetPaperSyncProtocolVersion: typeof PAPER_SYNC_PROTOCOL_VERSION;
  presenceProtocolVersion: typeof PAPER_PRESENCE_PROTOCOL_VERSION;
  rootFolderId: string;
  controlFolderId: string;
  layoutMigrationCompletionId: string;
  papers: Record<
    string,
    {
      presenceHeadIds: string[];
      paperFolderId: string;
      state: PaperPresenceState;
      packageHeadIds: string[];
    }
  >;
  createdBy: string;
  id: string;
}

export interface VerifiedPaperV3Control {
  controlFolder: DriveFileMetadata;
  layoutCompletion: PaperV3MigrationCompletion;
  protocolMigrationCompletion?: PaperProtocolMigrationCompletion;
}

export interface PaperPresenceFile {
  file: DriveFileMetadata;
  record: PaperPresenceGeneration;
}

export class PaperV3ControlIntegrityError extends Error {
  readonly failureCode?: TargetedPurgePresenceValidationFailureCode;
  readonly ancestryDiagnostic?: TargetedPurgePresenceAncestryDiagnostic;

  constructor(
    message: string,
    readonly documentId?: string,
    diagnostic?: {
      failureCode?: TargetedPurgePresenceValidationFailureCode;
      ancestryDiagnostic?: TargetedPurgePresenceAncestryDiagnostic;
    },
  ) {
    super(message);
    this.name = 'PaperV3ControlIntegrityError';
    this.failureCode = diagnostic?.failureCode;
    this.ancestryDiagnostic = diagnostic?.ancestryDiagnostic;
  }
}

export type PaperPresenceProtocolBoundaryFailureCode =
  | 'presence-protocol-context-unverified'
  | 'presence-protocol-marker-unsupported'
  | 'presence-protocol3-in-protocol2-root'
  | 'presence-protocol2-outside-cutover'
  | 'presence-cutover-head-missing-or-invalid'
  | 'presence-crosses-cutover-boundary'
  | 'presence-protocol-boundary-unexpected';

class PaperPresenceProtocolBoundaryError extends PaperV3ControlIntegrityError {
  readonly code: PaperPresenceProtocolBoundaryFailureCode;

  constructor(
    message: string,
    documentId: string | undefined,
    code: PaperPresenceProtocolBoundaryFailureCode,
  ) {
    super(message, documentId, { failureCode: code });
    this.name = 'PaperPresenceProtocolBoundaryError';
    this.code = code;
  }
}

export interface PaperPresenceResolutionOptions {
  /** The exact control folder was verified earlier in this operation. */
  controlValidated?: boolean;
  /**
   * Local account/root-scoped exceptions. Matching records are still downloaded,
   * parsed, hash-verified, and metadata-verified; only graph resolution is omitted.
   */
  ignoredDocumentIds?: readonly string[];
}

export type TargetedPurgePresenceBlockCode =
  | 'presence-scope-ambiguous'
  | 'presence-no-valid-ancestry'
  | 'presence-validation-failed'
  | 'ordinary-removal-available';

export interface TargetedPurgePresenceBlocker {
  code: TargetedPurgePresenceBlockCode;
  message: string;
}

export type TargetedPurgePresenceValidationFailureCode =
  | Exclude<PaperPresenceAncestryFailureCode, 'none'>
  | PaperPresenceProtocolBoundaryFailureCode
  | 'presence-paper-folder-unresolved';

/**
 * Read-only and deliberately redacted. Record ordinals are inspection-local;
 * no Drive, document, generation, folder, writer, or timestamp identity is
 * exposed through this diagnostic.
 */
export interface TargetedPurgePresenceAncestryDiagnostic {
  readonly schemaVersion: 1;
  readonly mode: 'read-only';
  readonly validationStage: 'ancestry' | 'protocol-boundary' | 'targeted-purge-safety';
  readonly failureCode: TargetedPurgePresenceValidationFailureCode;
  readonly ordering: {
    readonly timestamps: 'ignored';
    readonly driveListing: 'ignored';
  };
  readonly topology: PaperPresenceAncestryDiagnostic;
}

/**
 * Frozen, operation-local evidence. Drive identities are deliberately kept in
 * this opaque repository proof and must not be rendered by product UI.
 */
export interface TargetedPurgePresenceProof {
  readonly documentId: string;
  readonly controlFolderId: string;
  readonly paperFolderId: string;
  readonly displayName: string;
  readonly state: PaperPresenceState;
  readonly headIds: readonly string[];
  readonly validPresenceFileIds: readonly string[];
  readonly corruptPresenceFileIds: readonly string[];
  readonly evidenceFingerprint: string;
}

export interface TargetedPurgePresenceInspection {
  eligible: boolean;
  documentId: string;
  validPresenceCount: number;
  corruptPresenceCount: number;
  preservedPresenceCount: number;
  presenceHeadCount: number;
  presenceState?: PaperPresenceState;
  displayName?: string;
  paperFolderId?: string;
  proof?: TargetedPurgePresenceProof;
  blocker?: TargetedPurgePresenceBlocker;
  ancestryDiagnostic?: TargetedPurgePresenceAncestryDiagnostic;
}

export interface TargetedPurgePresenceExecutionResult {
  presence: ResolvedPaperPresence;
  corruptPresenceFilesTrashed: number;
  cleanupPending: boolean;
  cleanupError?: string;
}

interface TargetedPurgePresenceCandidate {
  file: DriveFileMetadata;
  contentSha256: string;
  record?: PaperPresenceGeneration;
  classification: 'valid' | 'corrupt';
}

interface TargetedPurgePresenceDetailedInspection {
  public: TargetedPurgePresenceInspection;
  validFiles: PaperPresenceFile[];
  corruptFiles: TargetedPurgePresenceCandidate[];
  resolved?: ResolvedPaperPresence;
}

export class PaperPresenceDriveRepository {
  private readonly verifiedPresenceFiles = new Map<string, PaperPresenceFile>();
  private readonly pendingPresenceFiles = new Map<string, Promise<PaperPresenceFile>>();
  private verifiedProtocolContext:
    | {
        protocolVersion: SupportedPaperSyncProtocolVersion;
        controlProtocolVersion: SupportedPaperSyncProtocolVersion;
        migrationCompletion?: PaperProtocolMigrationCompletion;
      }
    | undefined;

  constructor(
    private readonly drive: DriveClient,
    readonly rootFolderId: string,
    private readonly now: () => number = Date.now,
    private readonly persistVerifiedCacheEntries?: (
      entries: readonly PaperVerificationCacheEntry[],
    ) => Promise<void>,
  ) {
    if (!isSafeDriveId(rootFolderId)) throw new Error('Invalid Drive root identity.');
  }

  /**
   * Revalidates untrusted local cache bodies before admitting them to the
   * in-memory acceleration map. Fresh Drive metadata is still mandatory at
   * reuse time, so this cannot create or select remote ancestry.
   */
  async hydrateVerifiedCache(
    entries: readonly PaperVerificationCacheEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      if (entry.kind !== 'presence') continue;
      try {
        const record = parsePaperPresenceGeneration(entry.text);
        if (
          entry.text !== stableStringify(record) ||
          !(await verifyPaperPresenceGeneration(record)) ||
          !sameImmutablePresenceEvidence(entry.file, entry.file) ||
          !isPresenceMetadata(
            entry.file,
            record.controlFolderId,
            this.rootFolderId,
            record,
          )
        ) {
          continue;
        }
        this.verifiedPresenceFiles.set(entry.file.id, {
          file: entry.file,
          record,
        });
      } catch {
        // Cache corruption is a miss, never a remote integrity failure.
      }
    }
  }

  async createOrVerifyControlFolder(
    signal: AbortSignal,
    protocolVersion: SupportedPaperSyncProtocolVersion = PAPER_SYNC_PROTOCOL_VERSION,
  ): Promise<DriveFileMetadata> {
    let folders = await this.listControlFolders(signal);
    if (folders.length === 0) {
      await this.drive.createFolder(
        PAPER_V3_CONTROL_NAME,
        this.rootFolderId,
        controlProperties(this.rootFolderId, protocolVersion),
        signal,
        { phase: 'v3-control-creation', resource: 'control-folder' },
      );
      folders = await this.listControlFolders(signal);
    }
    if (folders.length !== 1) {
      throw new PaperV3ControlIntegrityError(
        'The managed Drive root does not have one unambiguous v3 control area.',
      );
    }
    const folder = folders[0];
    if (folder.appProperties?.paperProtocolVersion !== String(protocolVersion)) {
      throw new PaperV3ControlIntegrityError(
        'The Drive control area belongs to a different paper sync protocol.',
      );
    }
    await this.ensureLayoutDescriptor(folder, signal, protocolVersion);
    this.verifiedProtocolContext = {
      protocolVersion,
      controlProtocolVersion: protocolVersion,
    };
    return folder;
  }

  async verifyActivatedControl(
    expectedControlFolderId: string,
    expectedCompletionId: string,
    signal: AbortSignal,
    protocolMigrationCompletionId?: string,
    expectedRootProtocolVersion: SupportedPaperSyncProtocolVersion = PAPER_SYNC_PROTOCOL_VERSION,
  ): Promise<VerifiedPaperV3Control> {
    const [folders, descriptors, layoutCompletion, protocolCompletion] =
      await Promise.all([
        this.listControlFolders(signal),
        this.verifyLayoutDescriptor(expectedControlFolderId, signal),
        this.verifyMigrationCompletion(
          expectedControlFolderId,
          expectedCompletionId,
          signal,
        ),
        protocolMigrationCompletionId
          ? this.verifyProtocolMigrationCompletion(
              expectedControlFolderId,
              protocolMigrationCompletionId,
              signal,
            )
          : Promise.resolve(undefined),
      ]);
    if (
      folders.length !== 1 ||
      folders[0].id !== expectedControlFolderId ||
      !isControlFolder(folders[0], this.rootFolderId)
    ) {
      throw new PaperV3ControlIntegrityError(
        'The v3 Drive control area is missing or ambiguous.',
      );
    }
    const descriptor = descriptors.find(
      (candidate) =>
        candidate.paperSyncProtocolVersion ===
        layoutCompletion.paperSyncProtocolVersion,
    );
    if (!descriptor) {
      throw new PaperV3ControlIntegrityError(
        'The Drive layout descriptor and activation evidence disagree.',
      );
    }
    if (
      folders[0].appProperties?.paperProtocolVersion !==
      String(descriptor.paperSyncProtocolVersion)
    ) {
      throw new PaperV3ControlIntegrityError(
        'The Drive control folder and immutable layout evidence disagree.',
      );
    }
    if (expectedRootProtocolVersion === LEGACY_PAPER_SYNC_PROTOCOL_VERSION) {
      if (
        descriptor.paperSyncProtocolVersion !== LEGACY_PAPER_SYNC_PROTOCOL_VERSION ||
        protocolMigrationCompletionId !== undefined
      ) {
        throw new PaperV3ControlIntegrityError(
          'The protocol-2 root is not bound to protocol-2 control evidence.',
        );
      }
    } else if (
      descriptor.paperSyncProtocolVersion === LEGACY_PAPER_SYNC_PROTOCOL_VERSION
    ) {
      if (
        !protocolCompletion ||
        protocolCompletion.layoutMigrationCompletionId !== expectedCompletionId
      ) {
        throw new PaperV3ControlIntegrityError(
          'The protocol-3 root is not bound to its protocol migration evidence.',
        );
      }
    } else if (protocolMigrationCompletionId !== undefined) {
      throw new PaperV3ControlIntegrityError(
        'A native protocol-3 root has unexpected protocol migration evidence.',
      );
    }
    this.verifiedProtocolContext = {
      protocolVersion: expectedRootProtocolVersion,
      controlProtocolVersion: descriptor.paperSyncProtocolVersion,
      ...(protocolCompletion ? { migrationCompletion: protocolCompletion } : {}),
    };
    return {
      controlFolder: folders[0],
      layoutCompletion,
      ...(protocolCompletion
        ? { protocolMigrationCompletion: protocolCompletion }
        : {}),
    };
  }

  /** Small exact ancestry guard used alongside document commit revalidation. */
  async verifyCurrentControlFolder(
    controlFolderId: string,
    signal: AbortSignal,
    documentId?: string,
  ): Promise<DriveFileMetadata> {
    const folder = await this.drive.getMetadata(controlFolderId, signal, {
      phase: 'download-commit-guard',
      dependencyPhase: 'commit-guard',
      resource: 'control-folder',
      ...(documentId ? { documentId } : {}),
    });
    if (
      !isControlFolder(folder, this.rootFolderId) ||
      !this.verifiedProtocolContext ||
      folder.appProperties?.paperProtocolVersion !==
        String(this.verifiedProtocolContext.controlProtocolVersion)
    ) {
      throw new PaperV3ControlIntegrityError('The v3 Drive control area changed.');
    }
    return folder;
  }

  async resolveAll(
    controlFolderId: string,
    signal: AbortSignal,
    options: PaperPresenceResolutionOptions = {},
  ): Promise<Map<string, ResolvedPaperPresence>> {
    const ignoredDocumentIds = validatedIgnoredDocumentIds(options.ignoredDocumentIds);
    const records = await this.loadPresenceFiles(
      controlFolderId,
      signal,
      undefined,
      options,
    );
    const grouped = new Map<string, PaperPresenceGeneration[]>();
    for (const { record } of records) {
      if (ignoredDocumentIds.has(record.documentId)) continue;
      const group = grouped.get(record.documentId) ?? [];
      group.push(record);
      grouped.set(record.documentId, group);
    }
    const resolved = new Map<string, ResolvedPaperPresence>();
    for (const [documentId, generations] of [...grouped.entries()].sort(
      ([first], [second]) => compareCanonicalStrings(first, second),
    )) {
      const ancestry = await inspectPaperPresenceAncestry(generations);
      if (!ancestry.resolved) {
        const failureCode =
          ancestry.diagnostic.failureCode === 'none'
            ? 'presence-unexpected-validation-error'
            : ancestry.diagnostic.failureCode;
        throw new PaperV3ControlIntegrityError(
          'The verified presence records do not form one complete, valid ancestry graph.',
          documentId,
          {
            failureCode,
            ancestryDiagnostic: targetedPurgePresenceAncestryDiagnostic(
              'ancestry',
              failureCode,
              ancestry.diagnostic,
            ),
          },
        );
      }
      resolved.set(documentId, {
        ...ancestry.resolved,
        managedFileIds: records
          .filter(({ record }) => record.documentId === documentId)
          .map(({ file }) => file.id)
          .sort(compareCanonicalStrings),
      });
    }
    return resolved;
  }

  async resolveDocument(
    controlFolderId: string,
    documentId: string,
    signal: AbortSignal,
    options: PaperPresenceResolutionOptions = {},
  ): Promise<ResolvedPaperPresence | null> {
    if (!isValidDocumentId(documentId)) {
      throw new PaperV3ControlIntegrityError(
        'The paper-presence document identity is invalid.',
      );
    }
    const ignoredDocumentIds = validatedIgnoredDocumentIds(options.ignoredDocumentIds);
    const records = await this.loadPresenceFiles(
      controlFolderId,
      signal,
      documentId,
      options,
    );
    if (ignoredDocumentIds.has(documentId)) return null;
    if (records.length === 0) return null;
    const ancestry = await inspectPaperPresenceAncestry(
      records.map(({ record }) => record),
    );
    if (!ancestry.resolved) {
      const failureCode =
        ancestry.diagnostic.failureCode === 'none'
          ? 'presence-unexpected-validation-error'
          : ancestry.diagnostic.failureCode;
      throw new PaperV3ControlIntegrityError(
        'The verified presence records do not form one complete, valid ancestry graph.',
        documentId,
        {
          failureCode,
          ancestryDiagnostic: targetedPurgePresenceAncestryDiagnostic(
            'ancestry',
            failureCode,
            ancestry.diagnostic,
          ),
        },
      );
    }
    return {
      ...ancestry.resolved,
      managedFileIds: records.map(({ file }) => file.id).sort(compareCanonicalStrings),
    };
  }

  /**
   * Read-only, exact-document salvage inspection for the confirmation-gated
   * Targeted Purge flow. It accepts only corrupt *content* whose surrounding
   * Drive metadata still proves an exclusively owned presence artifact. Any
   * identity, ancestry, protocol, or metadata ambiguity is preserved and
   * blocks the operation.
   */
  async inspectTargetedPurgePresence(
    controlFolderId: string,
    documentId: string,
    signal: AbortSignal,
    options: PaperPresenceResolutionOptions = {},
  ): Promise<TargetedPurgePresenceInspection> {
    return (
      await this.inspectTargetedPurgePresenceDetailed(
        controlFolderId,
        documentId,
        signal,
        options,
      )
    ).public;
  }

  /**
   * Publishes a normal protocol-1 removed descendant from the verified valid
   * ancestry, then moves only the frozen corrupt siblings to Trash. The valid
   * immutable history and the new tombstone are always preserved.
   */
  async executeTargetedPurgePresence(
    proof: TargetedPurgePresenceProof,
    writer: PaperPresenceWriter,
    signal: AbortSignal,
    authorizeCommit?: () => Promise<void>,
  ): Promise<TargetedPurgePresenceExecutionResult> {
    const before = await this.inspectTargetedPurgePresenceDetailed(
      proof.controlFolderId,
      proof.documentId,
      signal,
      { controlValidated: true },
    );
    if (
      !before.public.eligible ||
      !before.public.proof ||
      !sameTargetedPurgePresenceProof(before.public.proof, proof) ||
      !before.resolved
    ) {
      throw new PaperV3ControlIntegrityError(
        'The targeted purge presence evidence changed after confirmation.',
        proof.documentId,
      );
    }

    let removed = before.resolved;
    await authorizeCommit?.();
    if (removed.state === 'present') {
      removed = await this.publishTargetedPurgeRemoved(proof, writer, signal);
    }
    if (removed.state !== 'removed' || removed.paperFolderId !== proof.paperFolderId) {
      throw new PaperV3ControlIntegrityError(
        'The targeted purge removal tombstone is not authoritative.',
        proof.documentId,
      );
    }

    // Re-read after tombstone publication. A concurrent explicit Restore must
    // stop cleanup before any pre-existing corrupt artifact is touched.
    const afterPublication = await this.inspectTargetedPurgePresenceDetailed(
      proof.controlFolderId,
      proof.documentId,
      signal,
      { controlValidated: true },
    );
    if (
      !afterPublication.resolved ||
      afterPublication.resolved.state !== 'removed' ||
      afterPublication.resolved.paperFolderId !== proof.paperFolderId ||
      !(await sameTargetedPurgeCorruptCandidates(
        before.corruptFiles,
        afterPublication.corruptFiles,
      ))
    ) {
      throw new PaperV3ControlIntegrityError(
        'Drive presence changed before targeted purge cleanup.',
        proof.documentId,
      );
    }

    let corruptPresenceFilesTrashed = 0;
    for (const candidate of afterPublication.corruptFiles) {
      signal.throwIfAborted();
      try {
        const current = await this.drive.getMetadata(candidate.file.id, signal, {
          phase: 'targeted-purge-presence-revalidation',
          resource: 'presence',
          documentId: proof.documentId,
        });
        const text = await this.drive.downloadText(candidate.file.id, signal, {
          phase: 'targeted-purge-presence-revalidation',
          resource: 'presence',
          documentId: proof.documentId,
        });
        if (
          !isTargetedPurgeScopedPresenceMetadata(
            current,
            proof.controlFolderId,
            this.rootFolderId,
            proof.documentId,
          ) ||
          (await targetedPurgePresenceCandidateFingerprint(
            current,
            await sha256Hex(text),
            'corrupt',
          )) !==
            (await targetedPurgePresenceCandidateFingerprint(
              candidate.file,
              candidate.contentSha256,
              'corrupt',
            ))
        ) {
          throw new PaperV3ControlIntegrityError(
            'A corrupt presence artifact changed before cleanup.',
            proof.documentId,
          );
        }
        const trashed = await this.drive.trashManagedTargetedPurgePresence(
          current.id,
          signal,
          {
            phase: 'targeted-purge-presence-cleanup',
            resource: 'presence',
            documentId: proof.documentId,
          },
        );
        if (trashed.id !== current.id || trashed.trashed !== true) {
          throw new Error('Google Drive did not confirm corrupt presence cleanup.');
        }
        this.verifiedPresenceFiles.delete(current.id);
        corruptPresenceFilesTrashed += 1;
      } catch (error) {
        return {
          presence: removed,
          corruptPresenceFilesTrashed,
          cleanupPending: true,
          cleanupError:
            error instanceof Error
              ? error.message
              : 'Corrupt presence cleanup did not finish.',
        };
      }
    }

    try {
      const verified = await this.requireResolved(
        proof.controlFolderId,
        proof.documentId,
        signal,
        { controlValidated: true },
      );
      if (
        verified.state !== 'removed' ||
        verified.paperFolderId !== proof.paperFolderId
      ) {
        throw new PaperV3ControlIntegrityError(
          'The cleaned paper-presence graph is not authoritatively removed.',
          proof.documentId,
        );
      }
      return {
        presence: verified,
        corruptPresenceFilesTrashed,
        cleanupPending: false,
      };
    } catch (error) {
      return {
        presence: removed,
        corruptPresenceFilesTrashed,
        cleanupPending: true,
        cleanupError:
          error instanceof Error
            ? error.message
            : 'The cleaned presence graph could not be verified.',
      };
    }
  }

  async publishMigrationBaseline(
    controlFolderId: string,
    input: {
      documentId: string;
      displayName: string;
      paperFolderId: string;
      state: PaperPresenceState;
      writer: PaperPresenceWriter;
    },
    signal: AbortSignal,
  ): Promise<ResolvedPaperPresence> {
    const current = await this.resolveDocument(
      controlFolderId,
      input.documentId,
      signal,
    );
    if (current) {
      if (
        current.state === input.state &&
        current.paperFolderId === input.paperFolderId &&
        current.heads.every((head) => head.intent === 'migration')
      ) {
        return current;
      }
      throw new PaperV3ControlIntegrityError(
        'The migration presence baseline conflicts with existing control data.',
        input.documentId,
      );
    }
    return this.publishGeneration(
      controlFolderId,
      {
        ...input,
        intent: 'migration',
        parents: [],
      },
      signal,
    );
  }

  async publishInitialUpload(
    controlFolderId: string,
    input: {
      documentId: string;
      displayName: string;
      paperFolderId: string;
      writer: PaperPresenceWriter;
    },
    signal: AbortSignal,
    knownCurrent?: ResolvedPaperPresence | null,
    authorizeCommit?: () => Promise<void>,
  ): Promise<ResolvedPaperPresence> {
    const current =
      knownCurrent === undefined
        ? await this.resolveDocument(controlFolderId, input.documentId, signal)
        : knownCurrent;
    if (current) {
      if (
        current.state === 'present' &&
        current.paperFolderId === input.paperFolderId
      ) {
        return current;
      }
      throw new PaperV3ControlIntegrityError(
        'Ordinary upload cannot replace an existing paper-presence state.',
        input.documentId,
      );
    }
    return this.publishGeneration(
      controlFolderId,
      {
        ...input,
        state: 'present',
        intent: 'upload',
        parents: [],
      },
      signal,
      [],
      undefined,
      { controlValidated: true },
      authorizeCommit,
    );
  }

  async publishRemoved(
    controlFolderId: string,
    input: {
      documentId: string;
      displayName: string;
      paperFolderId: string;
      writer: PaperPresenceWriter;
    },
    signal: AbortSignal,
    knownCurrent?: ResolvedPaperPresence,
    authorizeCommit?: () => Promise<void>,
  ): Promise<ResolvedPaperPresence> {
    const current =
      knownCurrent ??
      (await this.requireResolved(controlFolderId, input.documentId, signal));
    if (current.state === 'removed') return current;
    if (current.paperFolderId !== input.paperFolderId) {
      throw new PaperV3ControlIntegrityError(
        'The active paper folder changed before removal.',
        input.documentId,
      );
    }
    return this.publishGeneration(
      controlFolderId,
      {
        ...input,
        state: 'removed',
        intent: 'remove',
        parents: current.headIds,
      },
      signal,
      current.headIds,
      undefined,
      { controlValidated: true },
      authorizeCommit,
    );
  }

  async publishRestore(
    controlFolderId: string,
    input: {
      documentId: string;
      displayName: string;
      paperFolderId: string;
      writer: PaperPresenceWriter;
      expectedRemovedHeadIds: readonly string[];
      expectedRemovedPaperFolderId: string;
    },
    signal: AbortSignal,
    authorizeCommit?: () => Promise<void>,
  ): Promise<ResolvedPaperPresence> {
    return this.publishGeneration(
      controlFolderId,
      {
        ...input,
        state: 'present',
        intent: 'restore',
        parents: input.expectedRemovedHeadIds,
      },
      signal,
      input.expectedRemovedHeadIds,
      { state: 'removed', paperFolderId: input.expectedRemovedPaperFolderId },
      { controlValidated: true },
      authorizeCommit,
    );
  }

  async ensureMigrationCompletion(
    controlFolderId: string,
    presenceGenerations: PaperV3MigrationCompletion['presenceGenerations'],
    createdBy: string,
    signal: AbortSignal,
    sourceLayoutVersion: 0 | 2 = 2,
    protocolVersion: SupportedPaperSyncProtocolVersion = PAPER_SYNC_PROTOCOL_VERSION,
  ): Promise<PaperV3MigrationCompletion> {
    const control = await this.requireControlFolder(controlFolderId, signal);
    if (control.appProperties?.paperProtocolVersion !== String(protocolVersion)) {
      throw new PaperV3ControlIntegrityError(
        'The Drive control area belongs to a different paper sync protocol.',
      );
    }
    this.verifiedProtocolContext = {
      protocolVersion,
      controlProtocolVersion: protocolVersion,
    };
    const canonicalPresence = Object.fromEntries(
      Object.entries(presenceGenerations).sort(([first], [second]) =>
        compareCanonicalStrings(first, second),
      ),
    );
    const withoutId = {
      app: '39Note' as const,
      kind: 'paper-v3-migration-completion' as const,
      syncLayoutVersion: SYNC_LAYOUT_VERSION,
      paperSyncProtocolVersion: protocolVersion,
      presenceProtocolVersion: PAPER_PRESENCE_PROTOCOL_VERSION,
      rootFolderId: this.rootFolderId,
      controlFolderId,
      sourceLayoutVersion,
      presenceGenerations: canonicalPresence,
      createdBy,
    };
    const completion: PaperV3MigrationCompletion = {
      ...withoutId,
      id: await sha256Hex(stableStringify(withoutId)),
    };
    assertMigrationCompletion(completion, this.rootFolderId, control.id, completion.id);
    const text = stableStringify(completion);
    const name = `paper-v3-migration-${completion.id}.json`;
    const existing = await this.findExactManagedFile(
      controlFolderId,
      name,
      PAPER_V3_MIGRATION_ROLE,
      completion.id,
      signal,
    );
    if (existing) {
      if (
        (await this.drive.downloadText(existing.id, signal, {
          phase: 'v3-migration-completion',
          dependencyPhase: 'root-layout-guard',
          resource: 'migration-completion',
        })) !== text
      ) {
        throw new PaperV3ControlIntegrityError(
          'The existing v3 migration completion evidence is invalid.',
        );
      }
    } else {
      await this.drive.uploadFile(
        name,
        new Blob([text], { type: 'application/json' }),
        {
          parents: [controlFolderId],
          appProperties: {
            application: '39Note',
            role: PAPER_V3_MIGRATION_ROLE,
            rootFolderId: this.rootFolderId,
            controlFolderId,
            completionId: completion.id,
          },
        },
        signal,
        undefined,
        { phase: 'v3-migration-completion', resource: 'migration-completion' },
      );
    }
    await this.verifyMigrationCompletion(control.id, completion.id, signal, true);
    return completion;
  }

  async ensureProtocolMigrationCompletion(
    controlFolderId: string,
    layoutMigrationCompletionId: string,
    papers: PaperProtocolMigrationCompletion['papers'],
    createdBy: string,
    signal: AbortSignal,
  ): Promise<PaperProtocolMigrationCompletion> {
    const control = await this.requireControlFolder(controlFolderId, signal);
    const canonicalPapers = Object.fromEntries(
      Object.entries(papers)
        .sort(([first], [second]) => compareCanonicalStrings(first, second))
        .map(([documentId, paper]) => [
          documentId,
          {
            ...paper,
            presenceHeadIds: [...new Set(paper.presenceHeadIds)].sort(
              compareCanonicalStrings,
            ),
            packageHeadIds: [...new Set(paper.packageHeadIds)].sort(
              compareCanonicalStrings,
            ),
          },
        ]),
    );
    const withoutId = {
      app: '39Note' as const,
      kind: 'paper-protocol-migration-completion' as const,
      syncLayoutVersion: SYNC_LAYOUT_VERSION,
      sourcePaperSyncProtocolVersion: LEGACY_PAPER_SYNC_PROTOCOL_VERSION,
      targetPaperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
      presenceProtocolVersion: PAPER_PRESENCE_PROTOCOL_VERSION,
      rootFolderId: this.rootFolderId,
      controlFolderId,
      layoutMigrationCompletionId,
      papers: canonicalPapers,
      createdBy,
    };
    const completion: PaperProtocolMigrationCompletion = {
      ...withoutId,
      id: await sha256Hex(stableStringify(withoutId)),
    };
    assertProtocolMigrationCompletion(
      completion,
      this.rootFolderId,
      control.id,
      completion.id,
    );
    const text = stableStringify(completion);
    const name = `paper-protocol-v${PAPER_SYNC_PROTOCOL_VERSION}-${completion.id}.json`;
    const existing = await this.findExactManagedFile(
      controlFolderId,
      name,
      PAPER_PROTOCOL_MIGRATION_ROLE,
      completion.id,
      signal,
    );
    if (existing) {
      if ((await this.drive.downloadText(existing.id, signal)) !== text) {
        throw new PaperV3ControlIntegrityError(
          'The existing protocol migration evidence is invalid.',
        );
      }
    } else {
      await this.drive.uploadFile(
        name,
        new Blob([text], { type: 'application/json' }),
        {
          parents: [controlFolderId],
          appProperties: {
            application: '39Note',
            role: PAPER_PROTOCOL_MIGRATION_ROLE,
            rootFolderId: this.rootFolderId,
            controlFolderId,
            completionId: completion.id,
          },
        },
        signal,
      );
    }
    return this.verifyProtocolMigrationCompletion(
      controlFolderId,
      completion.id,
      signal,
    );
  }

  private async inspectTargetedPurgePresenceDetailed(
    controlFolderId: string,
    documentId: string,
    signal: AbortSignal,
    options: PaperPresenceResolutionOptions,
  ): Promise<TargetedPurgePresenceDetailedInspection> {
    if (!isValidDocumentId(documentId)) {
      throw new PaperV3ControlIntegrityError(
        'The targeted purge document identity is invalid.',
      );
    }
    if (!options.controlValidated) {
      await this.requireControlFolder(controlFolderId, signal);
    }
    const query = [
      `'${escapeDriveQueryValue(controlFolderId)}' in parents`,
      'trashed=false',
      `appProperties has { key='application' and value='39Note' }`,
      `appProperties has { key='role' and value='${PAPER_PRESENCE_ROLE}' }`,
      `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
    ].join(' and ');
    const files = dedupe(
      await this.drive.listFiles(query, signal, {
        phase: 'targeted-purge-presence-inspection',
        resource: 'presence',
        documentId,
      }),
    ).sort((first, second) => compareCanonicalStrings(first.id, second.id));
    if (files.length === 0) {
      return targetedPurgePresenceBlocked(
        documentId,
        'presence-no-valid-ancestry',
        'No authoritative paper-presence history exists for this paper.',
      );
    }

    const inspected = await mapWithConcurrency(
      files,
      PAPER_METADATA_CONCURRENCY,
      async (
        file,
      ): Promise<{
        candidate?: TargetedPurgePresenceCandidate;
        blocker?: TargetedPurgePresenceBlocker;
      }> => {
        signal.throwIfAborted();
        if (
          !isTargetedPurgeScopedPresenceMetadata(
            file,
            controlFolderId,
            this.rootFolderId,
            documentId,
          )
        ) {
          return {
            blocker: {
              code: 'presence-scope-ambiguous',
              message:
                'A claimed presence artifact does not have exact owned document/control metadata.',
            },
          };
        }
        const text = await this.drive.downloadText(file.id, signal, {
          phase: 'targeted-purge-presence-inspection',
          resource: 'presence',
          documentId,
        });
        const contentSha256 = await sha256Hex(text);
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          return {
            candidate: { file, contentSha256, classification: 'corrupt' },
          };
        }
        if (
          isRecord(raw) &&
          typeof raw.documentId === 'string' &&
          raw.documentId !== documentId
        ) {
          return {
            blocker: {
              code: 'presence-scope-ambiguous',
              message:
                'A presence artifact content identity disagrees with its Drive metadata.',
            },
          };
        }
        let record: PaperPresenceGeneration;
        try {
          record = parsePaperPresenceGeneration(text);
        } catch {
          return {
            candidate: { file, contentSha256, classification: 'corrupt' },
          };
        }
        if (!(await verifyPaperPresenceGeneration(record))) {
          return {
            candidate: { file, contentSha256, classification: 'corrupt' },
          };
        }
        if (
          record.documentId !== documentId ||
          !isPresenceMetadata(file, controlFolderId, this.rootFolderId, record)
        ) {
          return {
            blocker: {
              code: 'presence-scope-ambiguous',
              message:
                'A valid presence artifact crosses an identity or metadata boundary.',
            },
          };
        }
        return {
          candidate: {
            file,
            contentSha256,
            record,
            classification: 'valid',
          },
        };
      },
    );
    const hardBlocker = inspected.find(({ blocker }) => blocker)?.blocker;
    if (hardBlocker) {
      return targetedPurgePresenceBlocked(
        documentId,
        hardBlocker.code,
        hardBlocker.message,
      );
    }
    const candidates = inspected.flatMap(({ candidate }) =>
      candidate ? [candidate] : [],
    );
    const validCandidates = candidates.filter(
      (
        candidate,
      ): candidate is TargetedPurgePresenceCandidate & {
        record: PaperPresenceGeneration;
      } => candidate.classification === 'valid' && candidate.record !== undefined,
    );
    const corruptFiles = candidates.filter(
      (candidate) => candidate.classification === 'corrupt',
    );
    const validFiles: PaperPresenceFile[] = validCandidates.map(({ file, record }) => ({
      file,
      record,
    }));
    if (validFiles.length === 0) {
      return targetedPurgePresenceBlocked(
        documentId,
        'presence-no-valid-ancestry',
        'No verified presence ancestry remains from which a removal tombstone can safely descend.',
        0,
        corruptFiles.length,
      );
    }
    const ancestry = await inspectPaperPresenceAncestry(
      validFiles.map(({ record }) => record),
    );
    try {
      this.assertPresenceProtocolBoundary(validFiles, documentId);
    } catch (error) {
      return targetedPurgePresenceBlocked(
        documentId,
        'presence-validation-failed',
        'The verified presence records do not form one complete, valid ancestry graph.',
        validFiles.length,
        corruptFiles.length,
        targetedPurgePresenceAncestryDiagnostic(
          'protocol-boundary',
          error instanceof PaperPresenceProtocolBoundaryError
            ? error.code
            : 'presence-protocol-boundary-unexpected',
          ancestry.diagnostic,
        ),
      );
    }
    if (!ancestry.resolved) {
      return targetedPurgePresenceBlocked(
        documentId,
        'presence-validation-failed',
        'The verified presence records do not form one complete, valid ancestry graph.',
        validFiles.length,
        corruptFiles.length,
        targetedPurgePresenceAncestryDiagnostic(
          'ancestry',
          ancestry.diagnostic.failureCode === 'none'
            ? 'presence-unexpected-validation-error'
            : ancestry.diagnostic.failureCode,
          ancestry.diagnostic,
        ),
      );
    }
    const resolved: ResolvedPaperPresence = {
      ...ancestry.resolved,
      managedFileIds: validFiles
        .map(({ file }) => file.id)
        .sort(compareCanonicalStrings),
    };
    if (!resolved.paperFolderId) {
      return targetedPurgePresenceBlocked(
        documentId,
        'presence-validation-failed',
        'The authoritative presence heads do not identify one exact paper folder.',
        validFiles.length,
        corruptFiles.length,
        targetedPurgePresenceAncestryDiagnostic(
          'targeted-purge-safety',
          'presence-paper-folder-unresolved',
          ancestry.diagnostic,
        ),
      );
    }
    const candidateEvidence = await Promise.all(
      candidates.map((candidate) =>
        targetedPurgePresenceCandidateFingerprint(
          candidate.file,
          candidate.contentSha256,
          candidate.classification,
        ),
      ),
    );
    const evidenceFingerprint = await sha256Hex(
      stableStringify({
        rootFolderId: this.rootFolderId,
        controlFolderId,
        documentId,
        candidates: candidateEvidence.sort(compareCanonicalStrings),
        state: resolved.state,
        headIds: [...resolved.headIds].sort(compareCanonicalStrings),
        paperFolderId: resolved.paperFolderId,
      }),
    );
    if (resolved.state === 'present' && corruptFiles.length === 0) {
      return {
        public: {
          eligible: false,
          documentId,
          validPresenceCount: validFiles.length,
          corruptPresenceCount: 0,
          preservedPresenceCount: validFiles.length,
          presenceHeadCount: resolved.headIds.length,
          presenceState: resolved.state,
          displayName: resolved.displayName,
          paperFolderId: resolved.paperFolderId,
          blocker: {
            code: 'ordinary-removal-available',
            message:
              'Presence is healthy; use the ordinary Remove from Google Drive action.',
          },
        },
        validFiles,
        corruptFiles,
        resolved,
      };
    }
    const proof: TargetedPurgePresenceProof = {
      documentId,
      controlFolderId,
      paperFolderId: resolved.paperFolderId,
      displayName: resolved.displayName,
      state: resolved.state,
      headIds: [...resolved.headIds].sort(compareCanonicalStrings),
      validPresenceFileIds: validFiles
        .map(({ file }) => file.id)
        .sort(compareCanonicalStrings),
      corruptPresenceFileIds: corruptFiles
        .map(({ file }) => file.id)
        .sort(compareCanonicalStrings),
      evidenceFingerprint,
    };
    return {
      public: {
        eligible: true,
        documentId,
        validPresenceCount: validFiles.length,
        corruptPresenceCount: corruptFiles.length,
        preservedPresenceCount: validFiles.length,
        presenceHeadCount: resolved.headIds.length,
        presenceState: resolved.state,
        displayName: resolved.displayName,
        paperFolderId: resolved.paperFolderId,
        proof,
      },
      validFiles,
      corruptFiles,
      resolved,
    };
  }

  private async publishTargetedPurgeRemoved(
    proof: TargetedPurgePresenceProof,
    writer: PaperPresenceWriter,
    signal: AbortSignal,
  ): Promise<ResolvedPaperPresence> {
    const current = await this.inspectTargetedPurgePresenceDetailed(
      proof.controlFolderId,
      proof.documentId,
      signal,
      { controlValidated: true },
    );
    if (
      !current.public.eligible ||
      !current.public.proof ||
      !current.resolved ||
      current.resolved.state !== 'present' ||
      !sameTargetedPurgePresenceProof(current.public.proof, proof)
    ) {
      throw new PaperV3ControlIntegrityError(
        'Drive presence changed before the targeted purge tombstone publication.',
        proof.documentId,
      );
    }
    const record = await createPaperPresenceGeneration(
      {
        app: '39Note',
        syncLayoutVersion: SYNC_LAYOUT_VERSION,
        presenceProtocolVersion: PAPER_PRESENCE_PROTOCOL_VERSION,
        rootFolderId: this.rootFolderId,
        controlFolderId: proof.controlFolderId,
        documentId: proof.documentId,
        displayName: normalizeDisplayName(proof.displayName),
        state: 'removed',
        intent: 'remove',
        paperFolderId: proof.paperFolderId,
        writer: sanitizeWriter(writer),
      },
      {
        createdAt: this.now(),
        createdBy: writer.deviceId,
        parents: proof.headIds,
      },
    );
    const publicationProtocolVersion = this.verifiedProtocolContext?.protocolVersion;
    if (!publicationProtocolVersion) {
      throw new PaperV3ControlIntegrityError(
        'The paper sync protocol boundary was not verified before targeted purge.',
        proof.documentId,
      );
    }
    const text = stableStringify(record);
    const uploaded = await this.drive.uploadFile(
      `paper-presence-${record.generation.id}.json`,
      new Blob([text], { type: 'application/json' }),
      {
        parents: [proof.controlFolderId],
        appProperties: {
          application: '39Note',
          role: PAPER_PRESENCE_ROLE,
          rootFolderId: this.rootFolderId,
          controlFolderId: proof.controlFolderId,
          documentId: proof.documentId,
          state: 'removed',
          generationId: record.generation.id,
          presenceProtocolVersion: String(PAPER_PRESENCE_PROTOCOL_VERSION),
          paperProtocolVersion: String(publicationProtocolVersion),
        },
      },
      signal,
      undefined,
      {
        phase: 'targeted-purge-presence-publication',
        resource: 'presence',
        documentId: proof.documentId,
      },
    );
    const retainedText = await this.drive.downloadText(uploaded.id, signal, {
      phase: 'targeted-purge-presence-publication-verification',
      resource: 'presence',
      documentId: proof.documentId,
    });
    if (
      retainedText !== text ||
      !isPresenceMetadata(uploaded, proof.controlFolderId, this.rootFolderId, record)
    ) {
      throw new PaperV3ControlIntegrityError(
        'Google Drive did not retain the exact targeted purge tombstone.',
        proof.documentId,
      );
    }
    this.verifiedPresenceFiles.set(uploaded.id, { file: uploaded, record });
    const after = await this.inspectTargetedPurgePresenceDetailed(
      proof.controlFolderId,
      proof.documentId,
      signal,
      { controlValidated: true },
    );
    if (
      !after.resolved ||
      after.resolved.state !== 'removed' ||
      after.resolved.paperFolderId !== proof.paperFolderId ||
      !after.resolved.generationIds.includes(record.generation.id)
    ) {
      throw new PaperV3ControlIntegrityError(
        'The targeted purge tombstone is not authoritative.',
        proof.documentId,
      );
    }
    return after.resolved;
  }

  private async publishGeneration(
    controlFolderId: string,
    input: {
      documentId: string;
      displayName: string;
      paperFolderId: string;
      state: PaperPresenceState;
      intent: PaperPresenceIntent;
      writer: PaperPresenceWriter;
      parents: readonly string[];
    },
    signal: AbortSignal,
    expectedHeadIds: readonly string[] = [],
    expectedCurrent?: {
      state: PaperPresenceState;
      paperFolderId: string;
    },
    resolutionOptions: PaperPresenceResolutionOptions = {},
    authorizeCommit?: () => Promise<void>,
  ): Promise<ResolvedPaperPresence> {
    const record = await createPaperPresenceGeneration(
      {
        app: '39Note',
        syncLayoutVersion: SYNC_LAYOUT_VERSION,
        presenceProtocolVersion: PAPER_PRESENCE_PROTOCOL_VERSION,
        rootFolderId: this.rootFolderId,
        controlFolderId,
        documentId: input.documentId,
        displayName: normalizeDisplayName(input.displayName),
        state: input.state,
        intent: input.intent,
        paperFolderId: input.paperFolderId,
        writer: sanitizeWriter(input.writer),
      },
      {
        createdAt: this.now(),
        createdBy: input.writer.deviceId,
        parents: input.parents,
      },
    );
    const publicationProtocolVersion = this.verifiedProtocolContext?.protocolVersion;
    if (!publicationProtocolVersion) {
      throw new PaperV3ControlIntegrityError(
        'The paper sync protocol boundary was not verified before presence publication.',
        input.documentId,
      );
    }
    const text = stableStringify(record);
    const name = `paper-presence-${record.generation.id}.json`;
    const [before, existing] = await Promise.all([
      this.resolveDocument(
        controlFolderId,
        input.documentId,
        signal,
        resolutionOptions,
      ),
      this.findExactManagedFile(
        controlFolderId,
        name,
        PAPER_PRESENCE_ROLE,
        record.generation.id,
        signal,
      ),
      authorizeCommit?.(),
    ]);
    if (
      !sameIds(before?.headIds ?? [], expectedHeadIds) ||
      (expectedCurrent &&
        (!before ||
          before.state !== expectedCurrent.state ||
          before.paperFolderId !== expectedCurrent.paperFolderId))
    ) {
      throw new PaperV3ControlIntegrityError(
        'Drive presence changed before publication.',
        input.documentId,
      );
    }
    let pendingPublishedFile: Promise<PaperPresenceFile> | undefined;
    let pendingPublishedFileId: string | undefined;
    if (existing) {
      if (
        (await this.drive.downloadText(existing.id, signal, {
          phase: 'presence-publication',
          dependencyPhase: 'presence-commit',
          resource: 'presence',
          documentId: input.documentId,
        })) !== text
      ) {
        throw new PaperV3ControlIntegrityError(
          'A content-addressed paper-presence file is corrupt.',
          input.documentId,
        );
      }
    } else {
      const uploaded = await this.drive.uploadFile(
        name,
        new Blob([text], { type: 'application/json' }),
        {
          parents: [controlFolderId],
          appProperties: {
            application: '39Note',
            role: PAPER_PRESENCE_ROLE,
            rootFolderId: this.rootFolderId,
            controlFolderId,
            documentId: input.documentId,
            state: input.state,
            generationId: record.generation.id,
            presenceProtocolVersion: String(PAPER_PRESENCE_PROTOCOL_VERSION),
            paperProtocolVersion: String(publicationProtocolVersion),
          },
        },
        signal,
        undefined,
        {
          phase: 'presence-publication',
          resource: 'presence',
          documentId: input.documentId,
        },
      );
      pendingPublishedFileId = uploaded.id;
      pendingPublishedFile = this.drive
        .downloadText(uploaded.id, signal, {
          phase: 'presence-publication-verification',
          resource: 'presence',
          documentId: input.documentId,
        })
        .then((retainedText): PaperPresenceFile => {
          const retainedMetadata = isPresenceMetadata(
            uploaded,
            controlFolderId,
            this.rootFolderId,
            record,
          );
          if (retainedText !== text || !retainedMetadata) {
            this.drive.recordOperationStateTransition({
              phase: 'presence-publication-verification',
              transition: 'presence-upload-metadata-rejected',
              documentId: input.documentId,
              presenceState: input.state,
              outcome: 'failed',
              classification:
                retainedText !== text
                  ? 'uploaded-content-mismatch'
                  : uploaded.ownedByMe !== true
                    ? 'upload-response-missing-ownership-evidence'
                    : 'upload-response-metadata-mismatch',
            });
            throw new PaperV3ControlIntegrityError(
              'Google Drive did not retain the exact paper-presence generation.',
              input.documentId,
            );
          }
          return { file: uploaded, record };
        });
      this.pendingPresenceFiles.set(uploaded.id, pendingPublishedFile);
    }
    let resolved: ResolvedPaperPresence;
    try {
      [resolved] = await Promise.all([
        this.requireResolved(
          controlFolderId,
          input.documentId,
          signal,
          resolutionOptions,
        ),
        pendingPublishedFile,
      ]);
    } finally {
      if (pendingPublishedFileId) {
        this.pendingPresenceFiles.delete(pendingPublishedFileId);
      }
    }
    if (!resolved.headIds.includes(record.generation.id)) {
      throw new PaperV3ControlIntegrityError(
        'The published paper-presence generation is not authoritative.',
        input.documentId,
      );
    }
    if (input.state === 'present' && resolved.state !== 'present') {
      throw new PaperV3ControlIntegrityError(
        'A concurrent removal kept the paper removed.',
        input.documentId,
      );
    }
    if (input.state === 'removed' && resolved.state !== 'removed') {
      throw new PaperV3ControlIntegrityError(
        'The paper removal was not retained as authoritative.',
        input.documentId,
      );
    }
    return resolved;
  }

  private async loadPresenceFiles(
    controlFolderId: string,
    signal: AbortSignal,
    documentId?: string,
    options: PaperPresenceResolutionOptions = {},
  ): Promise<PaperPresenceFile[]> {
    if (!options.controlValidated) {
      await this.requireControlFolder(controlFolderId, signal);
    }
    const query = [
      `'${escapeDriveQueryValue(controlFolderId)}' in parents`,
      'trashed=false',
      `appProperties has { key='application' and value='39Note' }`,
      `appProperties has { key='role' and value='${PAPER_PRESENCE_ROLE}' }`,
      ...(documentId
        ? [
            `appProperties has { key='documentId' and value='${escapeDriveQueryValue(documentId)}' }`,
          ]
        : []),
    ].join(' and ');
    const files = dedupe(
      await this.drive.listFiles(query, signal, {
        phase: 'presence-discovery',
        resource: 'presence',
      }),
    );
    const prepared = await Promise.all(
      files.map(async (file) => {
        signal.throwIfAborted();
        const pending = this.pendingPresenceFiles.get(file.id);
        const pendingFile = pending ? await pending : undefined;
        const candidate =
          pendingFile && sameImmutablePresenceEvidence(pendingFile.file, file)
            ? pendingFile
            : this.verifiedPresenceFiles.get(file.id);
        const cached =
          candidate && sameImmutablePresenceEvidence(candidate.file, file)
            ? candidate
            : undefined;
        return { file, cached };
      }),
    );
    const loaded = await mapWithConcurrency(
      prepared,
      PAPER_METADATA_CONCURRENCY,
      async ({ file, cached }): Promise<PaperPresenceFile> => {
        signal.throwIfAborted();
        let record = cached?.record;
        if (!cached) {
          const text = await this.drive.downloadText(file.id, signal, {
            phase: 'presence-verification',
            resource: 'presence',
          });
          try {
            record = parsePaperPresenceGeneration(text);
          } catch (error) {
            this.verifiedPresenceFiles.delete(file.id);
            throw new PaperV3ControlIntegrityError(
              error instanceof Error ? error.message : 'Paper presence is invalid.',
              error instanceof PaperPresenceIntegrityError
                ? error.documentId
                : undefined,
              error instanceof PaperPresenceIntegrityError
                ? {
                    failureCode:
                      error.code === 'none'
                        ? 'presence-unexpected-validation-error'
                        : error.code,
                  }
                : { failureCode: 'presence-unexpected-validation-error' },
            );
          }
          if (!(await verifyPaperPresenceGeneration(record))) {
            this.verifiedPresenceFiles.delete(file.id);
            throw new PaperV3ControlIntegrityError(
              'A paper-presence record failed immutable verification.',
              record.documentId,
              { failureCode: 'presence-record-integrity-failed' },
            );
          }
        }
        if (
          !record ||
          !isPresenceMetadata(file, controlFolderId, this.rootFolderId, record)
        ) {
          this.verifiedPresenceFiles.delete(file.id);
          throw new PaperV3ControlIntegrityError(
            'A paper-presence record has invalid Drive metadata or content.',
            record?.documentId,
            { failureCode: 'presence-record-invalid' },
          );
        }
        this.verifiedPresenceFiles.set(file.id, { file, record });
        if (!cached && this.persistVerifiedCacheEntries) {
          // A failed or timed-out read must retain each completed immutable
          // verification, even when later records in this control area have
          // not been downloaded yet. This local hint remains non-authoritative.
          await this.persistVerifiedCacheEntries([
            { kind: 'presence', file, text: stableStringify(record) },
          ]);
        }
        return { file, record };
      },
    );
    const sorted = loaded.sort((first, second) =>
      compareCanonicalStrings(first.record.generation.id, second.record.generation.id),
    );
    try {
      this.assertPresenceProtocolBoundary(
        sorted,
        documentId,
        validatedIgnoredDocumentIds(options.ignoredDocumentIds),
      );
    } catch (error) {
      if (error instanceof PaperPresenceProtocolBoundaryError && error.documentId) {
        const ancestry = await inspectPaperPresenceAncestry(
          sorted
            .filter(({ record }) => record.documentId === error.documentId)
            .map(({ record }) => record),
        );
        throw new PaperV3ControlIntegrityError(error.message, error.documentId, {
          failureCode: error.code,
          ancestryDiagnostic: targetedPurgePresenceAncestryDiagnostic(
            'protocol-boundary',
            error.code,
            ancestry.diagnostic,
          ),
        });
      }
      throw error;
    }
    return sorted;
  }

  private assertPresenceProtocolBoundary(
    files: readonly PaperPresenceFile[],
    scopedDocumentId?: string,
    ignoredDocumentIds: ReadonlySet<string> = new Set(),
  ): void {
    const context = this.verifiedProtocolContext;
    if (!context) {
      throw new PaperPresenceProtocolBoundaryError(
        'The paper sync protocol boundary was not verified before presence resolution.',
        scopedDocumentId,
        'presence-protocol-context-unverified',
      );
    }
    const byDocument = new Map<string, PaperPresenceFile[]>();
    for (const file of files) {
      const matches = byDocument.get(file.record.documentId) ?? [];
      matches.push(file);
      byDocument.set(file.record.documentId, matches);
    }
    for (const [documentId, generations] of byDocument) {
      if (ignoredDocumentIds.has(documentId)) continue;
      const protocolFor = ({ file }: PaperPresenceFile) => {
        const value = file.appProperties?.paperProtocolVersion;
        if (
          value === undefined ||
          value === String(LEGACY_PAPER_SYNC_PROTOCOL_VERSION)
        ) {
          return LEGACY_PAPER_SYNC_PROTOCOL_VERSION;
        }
        if (value === String(PAPER_SYNC_PROTOCOL_VERSION)) {
          return PAPER_SYNC_PROTOCOL_VERSION;
        }
        throw new PaperPresenceProtocolBoundaryError(
          'A paper-presence generation has an unsupported protocol marker.',
          documentId,
          'presence-protocol-marker-unsupported',
        );
      };
      if (context.protocolVersion === LEGACY_PAPER_SYNC_PROTOCOL_VERSION) {
        if (
          generations.some(
            (generation) =>
              protocolFor(generation) !== LEGACY_PAPER_SYNC_PROTOCOL_VERSION,
          )
        ) {
          throw new PaperPresenceProtocolBoundaryError(
            'A protocol-2 root contains protocol-3 paper presence.',
            documentId,
            'presence-protocol3-in-protocol2-root',
          );
        }
        continue;
      }
      const evidence = context.migrationCompletion?.papers[documentId];
      if (!evidence) {
        if (
          generations.some(
            (generation) =>
              protocolFor(generation) === LEGACY_PAPER_SYNC_PROTOCOL_VERSION,
          )
        ) {
          throw new PaperPresenceProtocolBoundaryError(
            'Protocol-2 paper presence is outside the verified cutover set.',
            documentId,
            'presence-protocol2-outside-cutover',
          );
        }
        continue;
      }
      const byId = new Map(
        generations.map((generation) => [generation.record.generation.id, generation]),
      );
      if (
        evidence.presenceHeadIds.length === 0 ||
        evidence.presenceHeadIds.some((headId) => {
          const generation = byId.get(headId);
          return (
            !generation ||
            protocolFor(generation) !== LEGACY_PAPER_SYNC_PROTOCOL_VERSION
          );
        })
      ) {
        throw new PaperPresenceProtocolBoundaryError(
          'The protocol cutover presence heads are missing or invalid.',
          documentId,
          'presence-cutover-head-missing-or-invalid',
        );
      }
      for (const generation of generations) {
        const generationId = generation.record.generation.id;
        const insideLegacyHistory = evidence.presenceHeadIds.some((headId) =>
          presenceGenerationDescendsFrom(headId, generationId, byId),
        );
        const descendsFromCutover = evidence.presenceHeadIds.some((headId) =>
          presenceGenerationDescendsFrom(generationId, headId, byId),
        );
        const protocolVersion = protocolFor(generation);
        if (
          (protocolVersion === LEGACY_PAPER_SYNC_PROTOCOL_VERSION &&
            !insideLegacyHistory) ||
          (protocolVersion === PAPER_SYNC_PROTOCOL_VERSION && !descendsFromCutover)
        ) {
          throw new PaperPresenceProtocolBoundaryError(
            'A paper-presence generation crosses the verified protocol cutover boundary.',
            documentId,
            'presence-crosses-cutover-boundary',
          );
        }
      }
    }
  }

  private async ensureLayoutDescriptor(
    control: DriveFileMetadata,
    signal: AbortSignal,
    protocolVersion: SupportedPaperSyncProtocolVersion,
  ): Promise<void> {
    const descriptor = layoutDescriptor(this.rootFolderId, control.id, protocolVersion);
    const text = stableStringify(descriptor);
    const hash = await sha256Hex(text);
    const name = `paper-v3-layout-${hash}.json`;
    const existing = await this.findExactManagedFile(
      control.id,
      name,
      PAPER_V3_DESCRIPTOR_ROLE,
      hash,
      signal,
    );
    if (existing) {
      if (
        (await this.drive.downloadText(existing.id, signal, {
          phase: 'v3-layout-descriptor',
          dependencyPhase: 'root-layout-guard',
          resource: 'layout-descriptor',
        })) !== text
      ) {
        throw new PaperV3ControlIntegrityError(
          'The v3 Drive layout descriptor failed integrity verification.',
        );
      }
      await this.verifyLayoutDescriptor(control.id, signal);
      return;
    }
    await this.drive.uploadFile(
      name,
      new Blob([text], { type: 'application/json' }),
      {
        parents: [control.id],
        appProperties: {
          application: '39Note',
          role: PAPER_V3_DESCRIPTOR_ROLE,
          rootFolderId: this.rootFolderId,
          controlFolderId: control.id,
          sha256: hash,
        },
      },
      signal,
      undefined,
      { phase: 'v3-layout-descriptor', resource: 'layout-descriptor' },
    );
    await this.verifyLayoutDescriptor(control.id, signal);
  }

  private async verifyLayoutDescriptor(
    controlFolderId: string,
    signal: AbortSignal,
  ): Promise<PaperV3LayoutDescriptor[]> {
    const query = [
      `'${escapeDriveQueryValue(controlFolderId)}' in parents`,
      'trashed=false',
      `appProperties has { key='role' and value='${PAPER_V3_DESCRIPTOR_ROLE}' }`,
    ].join(' and ');
    const candidates = dedupe(
      await this.drive.listFiles(query, signal, {
        phase: 'v3-layout-descriptor',
        dependencyPhase: 'root-layout-guard',
        resource: 'layout-descriptor',
      }),
    );
    if (candidates.length === 0) {
      throw new PaperV3ControlIntegrityError(
        'The v3 Drive layout descriptor is missing.',
      );
    }
    const descriptors = await mapWithConcurrency(
      candidates,
      PAPER_METADATA_CONCURRENCY,
      async (file) => {
        const text = await this.drive.downloadText(file.id, signal, {
          phase: 'v3-layout-descriptor',
          dependencyPhase: 'root-layout-guard',
          resource: 'layout-descriptor',
        });
        let descriptor: unknown;
        try {
          descriptor = JSON.parse(text);
        } catch {
          throw new PaperV3ControlIntegrityError(
            'The v3 Drive layout descriptor is malformed.',
          );
        }
        assertLayoutDescriptor(descriptor, this.rootFolderId, controlFolderId);
        const hash = await sha256Hex(text);
        if (
          stableStringify(descriptor) !== text ||
          file.trashed ||
          file.ownedByMe !== true ||
          file.parents?.length !== 1 ||
          file.parents[0] !== controlFolderId ||
          file.name !== `paper-v3-layout-${hash}.json` ||
          file.appProperties?.application !== '39Note' ||
          file.appProperties.role !== PAPER_V3_DESCRIPTOR_ROLE ||
          file.appProperties.rootFolderId !== this.rootFolderId ||
          file.appProperties.controlFolderId !== controlFolderId ||
          file.appProperties.sha256 !== hash
        ) {
          throw new PaperV3ControlIntegrityError(
            'The v3 Drive layout descriptor is ambiguous or invalid.',
          );
        }
        return descriptor;
      },
    );
    return descriptors;
  }

  async verifyProtocolMigrationCompletion(
    controlFolderId: string,
    expectedId: string,
    signal: AbortSignal,
  ): Promise<PaperProtocolMigrationCompletion> {
    if (!isSha256(expectedId)) {
      throw new PaperV3ControlIntegrityError(
        'The protocol migration identity is invalid.',
      );
    }
    const file = await this.findExactManagedFile(
      controlFolderId,
      `paper-protocol-v${PAPER_SYNC_PROTOCOL_VERSION}-${expectedId}.json`,
      PAPER_PROTOCOL_MIGRATION_ROLE,
      expectedId,
      signal,
    );
    if (!file) {
      throw new PaperV3ControlIntegrityError(
        'The protocol migration completion evidence is missing.',
      );
    }
    if (
      file.appProperties?.rootFolderId !== this.rootFolderId ||
      file.appProperties.controlFolderId !== controlFolderId
    ) {
      throw new PaperV3ControlIntegrityError(
        'The protocol migration evidence crosses a control boundary.',
      );
    }
    const text = await this.drive.downloadText(file.id, signal);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new PaperV3ControlIntegrityError(
        'The protocol migration evidence is malformed.',
      );
    }
    assertProtocolMigrationCompletion(
      value,
      this.rootFolderId,
      controlFolderId,
      expectedId,
    );
    if (stableStringify(value) !== text) {
      throw new PaperV3ControlIntegrityError(
        'The protocol migration evidence is not canonical.',
      );
    }
    const { id, ...withoutId } = value;
    if ((await sha256Hex(stableStringify(withoutId))) !== id) {
      throw new PaperV3ControlIntegrityError(
        'The protocol migration evidence failed integrity verification.',
      );
    }
    return value;
  }

  private async verifyMigrationCompletion(
    controlFolderId: string,
    expectedId: string,
    signal: AbortSignal,
    verifyPresenceBaseline = false,
  ): Promise<PaperV3MigrationCompletion> {
    if (!isSha256(expectedId)) {
      throw new PaperV3ControlIntegrityError('The v3 migration identity is invalid.');
    }
    const file = await this.findExactManagedFile(
      controlFolderId,
      `paper-v3-migration-${expectedId}.json`,
      PAPER_V3_MIGRATION_ROLE,
      expectedId,
      signal,
    );
    if (!file) {
      throw new PaperV3ControlIntegrityError(
        'The v3 migration completion evidence is missing.',
      );
    }
    if (
      file.appProperties?.rootFolderId !== this.rootFolderId ||
      file.appProperties.controlFolderId !== controlFolderId
    ) {
      throw new PaperV3ControlIntegrityError(
        'The v3 migration completion metadata crosses a control boundary.',
      );
    }
    const text = await this.drive.downloadText(file.id, signal, {
      phase: 'v3-migration-completion',
      dependencyPhase: 'root-layout-guard',
      resource: 'migration-completion',
    });
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new PaperV3ControlIntegrityError(
        'The v3 migration completion evidence is malformed.',
      );
    }
    assertMigrationCompletion(value, this.rootFolderId, controlFolderId, expectedId);
    if (stableStringify(value) !== text) {
      throw new PaperV3ControlIntegrityError(
        'The v3 migration completion evidence is not canonical.',
      );
    }
    const { id, ...withoutId } = value;
    if ((await sha256Hex(stableStringify(withoutId))) !== id) {
      throw new PaperV3ControlIntegrityError(
        'The v3 migration completion evidence failed integrity verification.',
      );
    }
    if (verifyPresenceBaseline) {
      const allPresence = await this.resolveAll(controlFolderId, signal, {
        controlValidated: true,
      });
      const expectedDocumentIds = Object.keys(value.presenceGenerations);
      if (
        allPresence.size !== expectedDocumentIds.length ||
        expectedDocumentIds.some((documentId) => !allPresence.has(documentId))
      ) {
        throw new PaperV3ControlIntegrityError(
          'The v3 migration presence set does not match its completion evidence.',
        );
      }
      for (const [documentId, evidence] of Object.entries(value.presenceGenerations)) {
        const resolved = allPresence.get(documentId);
        if (
          !resolved ||
          !resolved.generationIds.includes(evidence.generationId) ||
          resolved.state !== evidence.state ||
          resolved.paperFolderId !== evidence.paperFolderId
        ) {
          throw new PaperV3ControlIntegrityError(
            'The v3 migration presence baseline no longer matches its evidence.',
            documentId,
          );
        }
      }
    }
    return value;
  }

  private async listControlFolders(signal: AbortSignal): Promise<DriveFileMetadata[]> {
    const query = [
      `'${escapeDriveQueryValue(this.rootFolderId)}' in parents`,
      'trashed=false',
      `mimeType='${FOLDER_MIME}'`,
      `appProperties has { key='application' and value='39Note' }`,
      `appProperties has { key='role' and value='${PAPER_V3_CONTROL_ROLE}' }`,
    ].join(' and ');
    const listed = dedupe(
      await this.drive.listFiles(query, signal, {
        phase: 'v3-control-discovery',
        resource: 'control-folder',
      }),
    );
    const folders: DriveFileMetadata[] = [];
    for (const file of listed) {
      if (isControlFolder(file, this.rootFolderId)) folders.push(file);
      else {
        throw new PaperV3ControlIntegrityError(
          'A claimed v3 Drive control folder has invalid ownership or ancestry.',
        );
      }
    }
    return folders.sort((first, second) =>
      compareCanonicalStrings(first.id, second.id),
    );
  }

  private async requireControlFolder(
    controlFolderId: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const folder = await this.drive.getMetadata(controlFolderId, signal, {
      phase: 'v3-control-verification',
      resource: 'control-folder',
    });
    if (!isControlFolder(folder, this.rootFolderId)) {
      throw new PaperV3ControlIntegrityError('The v3 Drive control area is invalid.');
    }
    return folder;
  }

  private async requireResolved(
    controlFolderId: string,
    documentId: string,
    signal: AbortSignal,
    options: PaperPresenceResolutionOptions = {},
  ): Promise<ResolvedPaperPresence> {
    const current = await this.resolveDocument(
      controlFolderId,
      documentId,
      signal,
      options,
    );
    if (!current) {
      throw new PaperV3ControlIntegrityError(
        'The paper has no authoritative v3 presence state.',
        documentId,
      );
    }
    return current;
  }

  private async findExactManagedFile(
    parentId: string,
    name: string,
    role: string,
    identity: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata | undefined> {
    const identityKey =
      role === PAPER_PRESENCE_ROLE
        ? 'generationId'
        : role === PAPER_V3_MIGRATION_ROLE || role === PAPER_PROTOCOL_MIGRATION_ROLE
          ? 'completionId'
          : 'sha256';
    const query = [
      `'${escapeDriveQueryValue(parentId)}' in parents`,
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false',
      `appProperties has { key='application' and value='39Note' }`,
      `appProperties has { key='role' and value='${escapeDriveQueryValue(role)}' }`,
      `appProperties has { key='${identityKey}' and value='${escapeDriveQueryValue(identity)}' }`,
    ].join(' and ');
    const resource =
      role === PAPER_PRESENCE_ROLE
        ? ('presence' as const)
        : role === PAPER_V3_MIGRATION_ROLE || role === PAPER_PROTOCOL_MIGRATION_ROLE
          ? ('migration-completion' as const)
          : role === PAPER_V3_DESCRIPTOR_ROLE
            ? ('layout-descriptor' as const)
            : ('unknown' as const);
    const phase =
      role === PAPER_PRESENCE_ROLE
        ? 'presence-exact-lookup'
        : role === PAPER_V3_MIGRATION_ROLE || role === PAPER_PROTOCOL_MIGRATION_ROLE
          ? 'v3-migration-completion'
          : 'v3-control-exact-lookup';
    const listed = dedupe(
      await this.drive.listFiles(query, signal, {
        phase,
        dependencyPhase:
          role === PAPER_PRESENCE_ROLE ? 'presence-resolution' : 'root-layout-guard',
        resource,
      }),
    );
    const matches: DriveFileMetadata[] = [];
    for (const file of listed) {
      if (
        file.trashed !== true &&
        file.ownedByMe === true &&
        file.name === name &&
        file.parents?.length === 1 &&
        file.parents[0] === parentId &&
        file.appProperties?.application === '39Note' &&
        file.appProperties.role === role &&
        file.appProperties[identityKey] === identity
      ) {
        matches.push(file);
      } else {
        throw new PaperV3ControlIntegrityError(
          'An immutable v3 control record has invalid ownership or ancestry.',
        );
      }
    }
    if (matches.length > 1) {
      throw new PaperV3ControlIntegrityError(
        'Duplicate immutable v3 control records were found.',
      );
    }
    return matches[0];
  }
}

function layoutDescriptor(
  rootFolderId: string,
  controlFolderId: string,
  protocolVersion: SupportedPaperSyncProtocolVersion = PAPER_SYNC_PROTOCOL_VERSION,
): PaperV3LayoutDescriptor {
  return {
    app: '39Note',
    kind: 'paper-v3-layout',
    syncLayoutVersion: SYNC_LAYOUT_VERSION,
    paperSyncProtocolVersion: protocolVersion,
    presenceProtocolVersion: PAPER_PRESENCE_PROTOCOL_VERSION,
    rootFolderId,
    controlFolderId,
  };
}

function controlProperties(
  rootFolderId: string,
  protocolVersion: SupportedPaperSyncProtocolVersion = PAPER_SYNC_PROTOCOL_VERSION,
): Record<string, string> {
  return {
    application: '39Note',
    role: PAPER_V3_CONTROL_ROLE,
    rootFolderId,
    layoutVersion: String(SYNC_LAYOUT_VERSION),
    paperProtocolVersion: String(protocolVersion),
    presenceProtocolVersion: String(PAPER_PRESENCE_PROTOCOL_VERSION),
  };
}

function isControlFolder(file: DriveFileMetadata, rootFolderId: string): boolean {
  const properties = file.appProperties;
  return (
    file.mimeType === FOLDER_MIME &&
    file.trashed !== true &&
    file.ownedByMe === true &&
    file.parents?.length === 1 &&
    file.parents[0] === rootFolderId &&
    properties?.application === '39Note' &&
    properties.role === PAPER_V3_CONTROL_ROLE &&
    properties.rootFolderId === rootFolderId &&
    properties.layoutVersion === String(SYNC_LAYOUT_VERSION) &&
    isSupportedPaperSyncProtocolProperty(properties.paperProtocolVersion) &&
    properties.presenceProtocolVersion === String(PAPER_PRESENCE_PROTOCOL_VERSION)
  );
}

function sameImmutablePresenceEvidence(
  first: DriveFileMetadata,
  second: DriveFileMetadata,
): boolean {
  if (
    !first.version ||
    !first.modifiedTime ||
    !first.md5Checksum ||
    first.size === undefined ||
    !second.version ||
    !second.modifiedTime ||
    !second.md5Checksum ||
    second.size === undefined
  ) {
    return false;
  }
  return (
    first.id === second.id &&
    first.name === second.name &&
    first.mimeType === second.mimeType &&
    first.version === second.version &&
    first.modifiedTime === second.modifiedTime &&
    first.md5Checksum === second.md5Checksum &&
    first.size === second.size &&
    first.trashed === second.trashed &&
    first.ownedByMe === second.ownedByMe &&
    stableStringify(first.parents ?? []) === stableStringify(second.parents ?? []) &&
    stableStringify(first.appProperties ?? {}) ===
      stableStringify(second.appProperties ?? {})
  );
}

function isPresenceMetadata(
  file: DriveFileMetadata,
  controlFolderId: string,
  rootFolderId: string,
  record: PaperPresenceGeneration,
): boolean {
  return (
    file.trashed !== true &&
    file.ownedByMe === true &&
    file.parents?.length === 1 &&
    file.parents[0] === controlFolderId &&
    file.name === `paper-presence-${record.generation.id}.json` &&
    file.appProperties?.application === '39Note' &&
    file.appProperties.role === PAPER_PRESENCE_ROLE &&
    file.appProperties.rootFolderId === rootFolderId &&
    file.appProperties.controlFolderId === controlFolderId &&
    file.appProperties.documentId === record.documentId &&
    file.appProperties.state === record.state &&
    file.appProperties.generationId === record.generation.id &&
    file.appProperties.presenceProtocolVersion ===
      String(PAPER_PRESENCE_PROTOCOL_VERSION) &&
    record.rootFolderId === rootFolderId &&
    record.controlFolderId === controlFolderId
  );
}

function assertMigrationCompletion(
  value: unknown,
  rootFolderId: string,
  controlFolderId: string,
  expectedId: string,
): asserts value is PaperV3MigrationCompletion {
  if (!isRecord(value) || !isRecord(value.presenceGenerations)) {
    throw new PaperV3ControlIntegrityError('The v3 migration evidence is invalid.');
  }
  if (
    value.app !== '39Note' ||
    value.kind !== 'paper-v3-migration-completion' ||
    value.syncLayoutVersion !== SYNC_LAYOUT_VERSION ||
    !isSupportedPaperSyncProtocolVersion(value.paperSyncProtocolVersion) ||
    value.presenceProtocolVersion !== PAPER_PRESENCE_PROTOCOL_VERSION ||
    value.rootFolderId !== rootFolderId ||
    value.controlFolderId !== controlFolderId ||
    (value.sourceLayoutVersion !== 0 && value.sourceLayoutVersion !== 2) ||
    value.id !== expectedId ||
    !isSha256(value.id) ||
    typeof value.createdBy !== 'string' ||
    !/^[A-Za-z0-9_-]{8,256}$/u.test(value.createdBy)
  ) {
    throw new PaperV3ControlIntegrityError('The v3 migration evidence is invalid.');
  }
  const documentIds = Object.keys(value.presenceGenerations);
  if (
    documentIds.some((id) => !isValidDocumentId(id)) ||
    documentIds.some((id, index) => index > 0 && documentIds[index - 1] >= id) ||
    Object.values(value.presenceGenerations).some(
      (entry) =>
        !isRecord(entry) ||
        !isSha256(entry.generationId) ||
        !isSafeDriveId(entry.paperFolderId) ||
        (entry.state !== 'present' && entry.state !== 'removed'),
    )
  ) {
    throw new PaperV3ControlIntegrityError('The v3 migration evidence is invalid.');
  }
}

function assertLayoutDescriptor(
  value: unknown,
  rootFolderId: string,
  controlFolderId: string,
): asserts value is PaperV3LayoutDescriptor {
  if (
    !isRecord(value) ||
    value.app !== '39Note' ||
    value.kind !== 'paper-v3-layout' ||
    value.syncLayoutVersion !== SYNC_LAYOUT_VERSION ||
    !isSupportedPaperSyncProtocolVersion(value.paperSyncProtocolVersion) ||
    value.presenceProtocolVersion !== PAPER_PRESENCE_PROTOCOL_VERSION ||
    value.rootFolderId !== rootFolderId ||
    value.controlFolderId !== controlFolderId
  ) {
    throw new PaperV3ControlIntegrityError(
      'The v3 Drive layout descriptor is invalid.',
    );
  }
}

function assertProtocolMigrationCompletion(
  value: unknown,
  rootFolderId: string,
  controlFolderId: string,
  expectedId: string,
): asserts value is PaperProtocolMigrationCompletion {
  if (!isRecord(value) || !isRecord(value.papers)) {
    throw new PaperV3ControlIntegrityError(
      'The protocol migration evidence is invalid.',
    );
  }
  if (
    value.app !== '39Note' ||
    value.kind !== 'paper-protocol-migration-completion' ||
    value.syncLayoutVersion !== SYNC_LAYOUT_VERSION ||
    value.sourcePaperSyncProtocolVersion !== LEGACY_PAPER_SYNC_PROTOCOL_VERSION ||
    value.targetPaperSyncProtocolVersion !== PAPER_SYNC_PROTOCOL_VERSION ||
    value.presenceProtocolVersion !== PAPER_PRESENCE_PROTOCOL_VERSION ||
    value.rootFolderId !== rootFolderId ||
    value.controlFolderId !== controlFolderId ||
    !isSha256(value.layoutMigrationCompletionId) ||
    value.id !== expectedId ||
    !isSha256(value.id) ||
    typeof value.createdBy !== 'string' ||
    !/^[A-Za-z0-9_-]{8,256}$/u.test(value.createdBy)
  ) {
    throw new PaperV3ControlIntegrityError(
      'The protocol migration evidence is invalid.',
    );
  }
  const documentIds = Object.keys(value.papers);
  if (
    documentIds.some((id) => !isValidDocumentId(id)) ||
    documentIds.some((id, index) => index > 0 && documentIds[index - 1] >= id) ||
    Object.values(value.papers).some(
      (paper) =>
        !isRecord(paper) ||
        !isSafeDriveId(paper.paperFolderId) ||
        (paper.state !== 'present' && paper.state !== 'removed') ||
        !isSortedUniqueHashes(paper.presenceHeadIds) ||
        paper.presenceHeadIds.length === 0 ||
        !isSortedUniqueHashes(paper.packageHeadIds) ||
        paper.packageHeadIds.length === 0,
    )
  ) {
    throw new PaperV3ControlIntegrityError(
      'The protocol migration evidence is invalid.',
    );
  }
}

function isSupportedPaperSyncProtocolVersion(
  value: unknown,
): value is SupportedPaperSyncProtocolVersion {
  return (
    value === LEGACY_PAPER_SYNC_PROTOCOL_VERSION ||
    value === PAPER_SYNC_PROTOCOL_VERSION
  );
}

function isSupportedPaperSyncProtocolProperty(value: unknown): boolean {
  return (
    value === String(LEGACY_PAPER_SYNC_PROTOCOL_VERSION) ||
    value === String(PAPER_SYNC_PROTOCOL_VERSION)
  );
}

function isSortedUniqueHashes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isSha256(item)) &&
    value.every((item, index) => index === 0 || value[index - 1] < item)
  );
}

function presenceGenerationDescendsFrom(
  generationId: string,
  ancestorId: string,
  generations: ReadonlyMap<string, PaperPresenceFile>,
): boolean {
  const pending = [generationId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next === ancestorId) return true;
    if (visited.has(next)) continue;
    visited.add(next);
    pending.push(...(generations.get(next)?.record.generation.parents ?? []));
  }
  return false;
}

function isTargetedPurgeScopedPresenceMetadata(
  file: DriveFileMetadata,
  controlFolderId: string,
  rootFolderId: string,
  documentId: string,
): boolean {
  const properties = file.appProperties;
  const generationId = properties?.generationId;
  return (
    file.trashed !== true &&
    file.mimeType === 'application/json' &&
    file.ownedByMe === true &&
    file.parents?.length === 1 &&
    file.parents[0] === controlFolderId &&
    properties?.application === '39Note' &&
    properties.role === PAPER_PRESENCE_ROLE &&
    properties.rootFolderId === rootFolderId &&
    properties.controlFolderId === controlFolderId &&
    properties.documentId === documentId &&
    (properties.state === 'present' || properties.state === 'removed') &&
    isSha256(generationId) &&
    file.name === `paper-presence-${generationId}.json` &&
    properties.presenceProtocolVersion === String(PAPER_PRESENCE_PROTOCOL_VERSION) &&
    isSupportedPaperSyncProtocolProperty(properties.paperProtocolVersion)
  );
}

async function targetedPurgePresenceCandidateFingerprint(
  file: DriveFileMetadata,
  contentSha256: string,
  classification: TargetedPurgePresenceCandidate['classification'],
): Promise<string> {
  return sha256Hex(
    stableStringify({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: [...(file.parents ?? [])].sort(compareCanonicalStrings),
      appProperties: file.appProperties ?? {},
      modifiedTime: file.modifiedTime ?? null,
      version: file.version ?? null,
      size: file.size ?? null,
      md5Checksum: file.md5Checksum ?? null,
      trashed: file.trashed === true,
      ownedByMe: file.ownedByMe === true,
      contentSha256,
      classification,
    }),
  );
}

async function sameTargetedPurgeCorruptCandidates(
  first: readonly TargetedPurgePresenceCandidate[],
  second: readonly TargetedPurgePresenceCandidate[],
): Promise<boolean> {
  const fingerprints = async (values: readonly TargetedPurgePresenceCandidate[]) =>
    (
      await Promise.all(
        values.map((candidate) =>
          targetedPurgePresenceCandidateFingerprint(
            candidate.file,
            candidate.contentSha256,
            candidate.classification,
          ),
        ),
      )
    ).sort(compareCanonicalStrings);
  return sameIds(await fingerprints(first), await fingerprints(second));
}

function sameTargetedPurgePresenceProof(
  first: TargetedPurgePresenceProof,
  second: TargetedPurgePresenceProof,
): boolean {
  return (
    first.documentId === second.documentId &&
    first.controlFolderId === second.controlFolderId &&
    first.paperFolderId === second.paperFolderId &&
    first.displayName === second.displayName &&
    first.state === second.state &&
    first.evidenceFingerprint === second.evidenceFingerprint &&
    sameIds(first.headIds, second.headIds) &&
    sameIds(first.validPresenceFileIds, second.validPresenceFileIds) &&
    sameIds(first.corruptPresenceFileIds, second.corruptPresenceFileIds)
  );
}

function targetedPurgePresenceBlocked(
  documentId: string,
  code: TargetedPurgePresenceBlockCode,
  message: string,
  validPresenceCount = 0,
  corruptPresenceCount = 0,
  ancestryDiagnostic?: TargetedPurgePresenceAncestryDiagnostic,
): TargetedPurgePresenceDetailedInspection {
  return {
    public: {
      eligible: false,
      documentId,
      validPresenceCount,
      corruptPresenceCount,
      preservedPresenceCount: validPresenceCount,
      presenceHeadCount: 0,
      blocker: { code, message },
      ...(ancestryDiagnostic ? { ancestryDiagnostic } : {}),
    },
    validFiles: [],
    corruptFiles: [],
  };
}

function targetedPurgePresenceAncestryDiagnostic(
  validationStage: TargetedPurgePresenceAncestryDiagnostic['validationStage'],
  failureCode: TargetedPurgePresenceValidationFailureCode,
  topology: PaperPresenceAncestryDiagnostic,
): TargetedPurgePresenceAncestryDiagnostic {
  return {
    schemaVersion: 1,
    mode: 'read-only',
    validationStage,
    failureCode,
    ordering: {
      timestamps: 'ignored',
      driveListing: 'ignored',
    },
    topology,
  };
}

function sanitizeWriter(writer: PaperPresenceWriter): PaperPresenceWriter {
  return {
    deviceId: writer.deviceId,
    ...(writer.deviceLabel
      ? { deviceLabel: normalizeDisplayName(writer.deviceLabel).slice(0, 80) }
      : {}),
  };
}

function normalizeDisplayName(value: string): string {
  const normalized = Array.from(value)
    .map((character) => ((character.codePointAt(0) ?? 0) <= 31 ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180);
  return normalized || 'Untitled paper';
}

function dedupe(files: readonly DriveFileMetadata[]): DriveFileMetadata[] {
  return [...new Map(files.map((file) => [file.id, file])).values()];
}

function sameIds(first: readonly string[], second: readonly string[]): boolean {
  return (
    JSON.stringify([...new Set(first)].sort(compareCanonicalStrings)) ===
    JSON.stringify([...new Set(second)].sort(compareCanonicalStrings))
  );
}

function validatedIgnoredDocumentIds(
  values: readonly string[] | undefined,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (!isValidDocumentId(value)) {
      throw new PaperV3ControlIntegrityError(
        'A local ignored-paper identity is invalid.',
      );
    }
    result.add(value);
  }
  return result;
}

function isSafeDriveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
