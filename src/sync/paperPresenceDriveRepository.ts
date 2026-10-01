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
  PAPER_V3_CONTROL_NAME,
  PAPER_V3_CONTROL_ROLE,
  PAPER_V3_DESCRIPTOR_ROLE,
  PAPER_V3_MIGRATION_ROLE,
  createPaperPresenceGeneration,
  parsePaperPresenceGeneration,
  resolvePaperPresence,
  verifyPaperPresenceGeneration,
  type PaperPresenceGeneration,
  type PaperPresenceIntent,
  type PaperPresenceState,
  type PaperPresenceWriter,
  type ResolvedPaperPresence,
} from './paperPresence.ts';
import { PAPER_SYNC_PROTOCOL_VERSION, SYNC_LAYOUT_VERSION } from './paperTypes.ts';
import { PAPER_METADATA_CONCURRENCY, mapWithConcurrency } from './syncConcurrency.ts';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface PaperV3LayoutDescriptor {
  app: '39Note';
  kind: 'paper-v3-layout';
  syncLayoutVersion: typeof SYNC_LAYOUT_VERSION;
  paperSyncProtocolVersion: typeof PAPER_SYNC_PROTOCOL_VERSION;
  presenceProtocolVersion: typeof PAPER_PRESENCE_PROTOCOL_VERSION;
  rootFolderId: string;
  controlFolderId: string;
}

export interface PaperV3MigrationCompletion {
  app: '39Note';
  kind: 'paper-v3-migration-completion';
  syncLayoutVersion: typeof SYNC_LAYOUT_VERSION;
  paperSyncProtocolVersion: typeof PAPER_SYNC_PROTOCOL_VERSION;
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

export interface PaperPresenceFile {
  file: DriveFileMetadata;
  record: PaperPresenceGeneration;
}

export class PaperV3ControlIntegrityError extends Error {
  constructor(
    message: string,
    readonly documentId?: string,
  ) {
    super(message);
    this.name = 'PaperV3ControlIntegrityError';
  }
}

export interface PaperPresenceResolutionOptions {
  /** The exact control folder was verified earlier in this operation. */
  controlValidated?: boolean;
}

export class PaperPresenceDriveRepository {
  private readonly verifiedPresenceFiles = new Map<string, PaperPresenceFile>();
  private readonly pendingPresenceFiles = new Map<string, Promise<PaperPresenceFile>>();

  constructor(
    private readonly drive: DriveClient,
    readonly rootFolderId: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!isSafeDriveId(rootFolderId)) throw new Error('Invalid Drive root identity.');
  }

  async createOrVerifyControlFolder(signal: AbortSignal): Promise<DriveFileMetadata> {
    let folders = await this.listControlFolders(signal);
    if (folders.length === 0) {
      await this.drive.createFolder(
        PAPER_V3_CONTROL_NAME,
        this.rootFolderId,
        controlProperties(this.rootFolderId),
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
    await this.ensureLayoutDescriptor(folder, signal);
    return folder;
  }

  async verifyActivatedControl(
    expectedControlFolderId: string,
    expectedCompletionId: string,
    signal: AbortSignal,
  ): Promise<DriveFileMetadata> {
    const [folders] = await Promise.all([
      this.listControlFolders(signal),
      this.verifyLayoutDescriptor(expectedControlFolderId, signal),
      this.verifyMigrationCompletion(
        expectedControlFolderId,
        expectedCompletionId,
        signal,
      ),
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
    return folders[0];
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
    if (!isControlFolder(folder, this.rootFolderId)) {
      throw new PaperV3ControlIntegrityError('The v3 Drive control area changed.');
    }
    return folder;
  }

  async resolveAll(
    controlFolderId: string,
    signal: AbortSignal,
    options: PaperPresenceResolutionOptions = {},
  ): Promise<Map<string, ResolvedPaperPresence>> {
    const records = await this.loadPresenceFiles(
      controlFolderId,
      signal,
      undefined,
      options,
    );
    const grouped = new Map<string, PaperPresenceGeneration[]>();
    for (const { record } of records) {
      const group = grouped.get(record.documentId) ?? [];
      group.push(record);
      grouped.set(record.documentId, group);
    }
    const resolved = new Map<string, ResolvedPaperPresence>();
    for (const [documentId, generations] of [...grouped.entries()].sort(
      ([first], [second]) => compareCanonicalStrings(first, second),
    )) {
      try {
        resolved.set(documentId, {
          ...(await resolvePaperPresence(generations)),
          managedFileIds: records
            .filter(({ record }) => record.documentId === documentId)
            .map(({ file }) => file.id)
            .sort(compareCanonicalStrings),
        });
      } catch (error) {
        throw new PaperV3ControlIntegrityError(
          error instanceof Error ? error.message : 'Paper presence is invalid.',
          documentId,
        );
      }
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
    const records = await this.loadPresenceFiles(
      controlFolderId,
      signal,
      documentId,
      options,
    );
    if (records.length === 0) return null;
    try {
      return {
        ...(await resolvePaperPresence(records.map(({ record }) => record))),
        managedFileIds: records
          .map(({ file }) => file.id)
          .sort(compareCanonicalStrings),
      };
    } catch (error) {
      throw new PaperV3ControlIntegrityError(
        error instanceof Error ? error.message : 'Paper presence is invalid.',
        documentId,
      );
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
  ): Promise<PaperV3MigrationCompletion> {
    const control = await this.requireControlFolder(controlFolderId, signal);
    const canonicalPresence = Object.fromEntries(
      Object.entries(presenceGenerations).sort(([first], [second]) =>
        compareCanonicalStrings(first, second),
      ),
    );
    const withoutId = {
      app: '39Note' as const,
      kind: 'paper-v3-migration-completion' as const,
      syncLayoutVersion: SYNC_LAYOUT_VERSION,
      paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
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
    const loaded = await mapWithConcurrency(
      files,
      PAPER_METADATA_CONCURRENCY,
      async (file): Promise<PaperPresenceFile> => {
        signal.throwIfAborted();
        const pending = this.pendingPresenceFiles.get(file.id);
        const pendingFile = pending ? await pending : undefined;
        const cached =
          pendingFile && sameImmutablePresenceEvidence(pendingFile.file, file)
            ? pendingFile
            : this.verifiedPresenceFiles.get(file.id);
        let record = cached?.record;
        if (!cached || !sameImmutablePresenceEvidence(cached.file, file)) {
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
            );
          }
          if (!(await verifyPaperPresenceGeneration(record))) {
            this.verifiedPresenceFiles.delete(file.id);
            throw new PaperV3ControlIntegrityError(
              'A paper-presence record failed immutable verification.',
              record.documentId,
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
          );
        }
        this.verifiedPresenceFiles.set(file.id, { file, record });
        return { file, record };
      },
    );
    return loaded.sort((first, second) =>
      compareCanonicalStrings(first.record.generation.id, second.record.generation.id),
    );
  }

  private async ensureLayoutDescriptor(
    control: DriveFileMetadata,
    signal: AbortSignal,
  ): Promise<void> {
    const descriptor = layoutDescriptor(this.rootFolderId, control.id);
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
  ): Promise<void> {
    const expected = layoutDescriptor(this.rootFolderId, controlFolderId);
    const text = stableStringify(expected);
    const hash = await sha256Hex(text);
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
    await mapWithConcurrency(candidates, PAPER_METADATA_CONCURRENCY, async (file) => {
      if (
        file.trashed ||
        file.ownedByMe !== true ||
        file.parents?.length !== 1 ||
        file.parents[0] !== controlFolderId ||
        file.name !== `paper-v3-layout-${hash}.json` ||
        file.appProperties?.application !== '39Note' ||
        file.appProperties.role !== PAPER_V3_DESCRIPTOR_ROLE ||
        file.appProperties.rootFolderId !== this.rootFolderId ||
        file.appProperties.controlFolderId !== controlFolderId ||
        file.appProperties.sha256 !== hash ||
        (await this.drive.downloadText(file.id, signal, {
          phase: 'v3-layout-descriptor',
          dependencyPhase: 'root-layout-guard',
          resource: 'layout-descriptor',
        })) !== text
      ) {
        throw new PaperV3ControlIntegrityError(
          'The v3 Drive layout descriptor is ambiguous or invalid.',
        );
      }
    });
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
        : role === PAPER_V3_MIGRATION_ROLE
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
        : role === PAPER_V3_MIGRATION_ROLE
          ? ('migration-completion' as const)
          : role === PAPER_V3_DESCRIPTOR_ROLE
            ? ('layout-descriptor' as const)
            : ('unknown' as const);
    const phase =
      role === PAPER_PRESENCE_ROLE
        ? 'presence-exact-lookup'
        : role === PAPER_V3_MIGRATION_ROLE
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
): PaperV3LayoutDescriptor {
  return {
    app: '39Note',
    kind: 'paper-v3-layout',
    syncLayoutVersion: SYNC_LAYOUT_VERSION,
    paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
    presenceProtocolVersion: PAPER_PRESENCE_PROTOCOL_VERSION,
    rootFolderId,
    controlFolderId,
  };
}

function controlProperties(rootFolderId: string): Record<string, string> {
  return {
    application: '39Note',
    role: PAPER_V3_CONTROL_ROLE,
    rootFolderId,
    layoutVersion: String(SYNC_LAYOUT_VERSION),
    paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
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
    properties.paperProtocolVersion === String(PAPER_SYNC_PROTOCOL_VERSION) &&
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
    value.paperSyncProtocolVersion !== PAPER_SYNC_PROTOCOL_VERSION ||
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

function isSafeDriveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
