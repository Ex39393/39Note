import { isValidDocumentId } from '../utils/documentId.ts';
import {
  compareCanonicalStrings,
  isSha256,
  sha256Hex,
  stableStringify,
} from './hash.ts';
import { SYNC_LAYOUT_VERSION } from './paperTypes.ts';

export const PAPER_PRESENCE_PROTOCOL_VERSION = 1 as const;
export const PAPER_V3_CONTROL_NAME = '39Note Control';
export const PAPER_V3_CONTROL_ROLE = 'paper-v3-control';
export const PAPER_V3_DESCRIPTOR_ROLE = 'paper-v3-layout-descriptor';
export const PAPER_PRESENCE_ROLE = 'paper-presence-generation';
export const PAPER_V3_MIGRATION_ROLE = 'paper-v3-migration-completion';

export type PaperPresenceState = 'present' | 'removed';
export type PaperPresenceIntent = 'migration' | 'upload' | 'remove' | 'restore';

export interface PaperPresenceWriter {
  deviceId: string;
  deviceLabel?: string;
}

export interface PaperPresenceGeneration {
  app: '39Note';
  syncLayoutVersion: typeof SYNC_LAYOUT_VERSION;
  presenceProtocolVersion: typeof PAPER_PRESENCE_PROTOCOL_VERSION;
  rootFolderId: string;
  controlFolderId: string;
  documentId: string;
  displayName: string;
  state: PaperPresenceState;
  intent: PaperPresenceIntent;
  /** The active folder for present, or the last exact cleanup target for removed. */
  paperFolderId: string;
  writer: PaperPresenceWriter;
  generation: {
    /** SHA-256 over the canonical record with this field omitted. */
    id: string;
    /** Audit information only. It is never used to choose a head. */
    createdAt: number;
    createdBy: string;
    parents: string[];
  };
}

export type PaperPresenceGenerationBase = Omit<PaperPresenceGeneration, 'generation'>;

export interface ResolvedPaperPresence {
  documentId: string;
  state: PaperPresenceState;
  headIds: string[];
  heads: PaperPresenceGeneration[];
  generationIds: string[];
  /** Drive file IDs containing the verified immutable generations. */
  managedFileIds?: string[];
  paperFolderId?: string;
  displayName: string;
}

export class PaperPresenceIntegrityError extends Error {
  readonly documentId?: string;

  constructor(message: string, documentId?: string) {
    super(message);
    this.name = 'PaperPresenceIntegrityError';
    this.documentId = documentId;
  }
}

export async function createPaperPresenceGeneration(
  base: PaperPresenceGenerationBase,
  generation: {
    createdAt: number;
    createdBy: string;
    parents: readonly string[];
  },
): Promise<PaperPresenceGeneration> {
  const withoutId = {
    createdAt: generation.createdAt,
    createdBy: generation.createdBy,
    parents: [...new Set(generation.parents)].sort(compareCanonicalStrings),
  };
  const record: PaperPresenceGeneration = {
    ...base,
    generation: {
      id: await sha256Hex(stableStringify({ ...base, generation: withoutId })),
      ...withoutId,
    },
  };
  assertPaperPresenceGeneration(record);
  return record;
}

export function parsePaperPresenceGeneration(text: string): PaperPresenceGeneration {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PaperPresenceIntegrityError(
      'A Drive paper-presence record contains malformed JSON.',
    );
  }
  assertPaperPresenceGeneration(value);
  if (stableStringify(value) !== text) {
    throw new PaperPresenceIntegrityError(
      'A Drive paper-presence record is not canonical.',
      value.documentId,
    );
  }
  return value;
}

export async function verifyPaperPresenceGeneration(
  record: PaperPresenceGeneration,
): Promise<boolean> {
  try {
    assertPaperPresenceGeneration(record);
  } catch {
    return false;
  }
  const { id, ...generation } = record.generation;
  return (await sha256Hex(stableStringify({ ...record, generation }))) === id;
}

/**
 * Resolves immutable ancestry only. Timestamps and Drive ordering are deliberately
 * ignored. Any concurrent removed head dominates ordinary/stale present work.
 */
export async function resolvePaperPresence(
  input: readonly PaperPresenceGeneration[],
): Promise<ResolvedPaperPresence> {
  if (input.length === 0) {
    throw new PaperPresenceIntegrityError('A v3 paper has no presence generation.');
  }
  const documentId = input[0].documentId;
  const rootFolderId = input[0].rootFolderId;
  const controlFolderId = input[0].controlFolderId;
  const byId = new Map<string, PaperPresenceGeneration>();
  for (const record of input) {
    assertPaperPresenceGeneration(record);
    if (!(await verifyPaperPresenceGeneration(record))) {
      throw new PaperPresenceIntegrityError(
        'A Drive paper-presence record failed integrity verification.',
        record.documentId,
      );
    }
    if (
      record.documentId !== documentId ||
      record.rootFolderId !== rootFolderId ||
      record.controlFolderId !== controlFolderId
    ) {
      throw new PaperPresenceIntegrityError(
        'Paper-presence records cross an identity or control boundary.',
        documentId,
      );
    }
    const existing = byId.get(record.generation.id);
    if (existing && stableStringify(existing) !== stableStringify(record)) {
      throw new PaperPresenceIntegrityError(
        'Conflicting paper-presence records claim the same generation.',
        documentId,
      );
    }
    byId.set(record.generation.id, record);
  }

  for (const record of byId.values()) {
    for (const parentId of record.generation.parents) {
      if (!byId.has(parentId)) {
        throw new PaperPresenceIntegrityError(
          'A paper-presence generation references a missing parent.',
          documentId,
        );
      }
    }
  }
  assertAcyclic(byId, documentId);
  assertValidPresenceTransitions(byId, documentId);

  const referenced = new Set(
    [...byId.values()].flatMap((record) => record.generation.parents),
  );
  const heads = [...byId.values()]
    .filter((record) => !referenced.has(record.generation.id))
    .sort((first, second) =>
      compareCanonicalStrings(first.generation.id, second.generation.id),
    );
  if (heads.length === 0) {
    throw new PaperPresenceIntegrityError(
      'The paper-presence graph has no authoritative head.',
      documentId,
    );
  }

  const state: PaperPresenceState = heads.some((head) => head.state === 'removed')
    ? 'removed'
    : 'present';
  const effectiveHeads =
    state === 'removed' ? heads.filter((head) => head.state === 'removed') : heads;
  const folderIds = new Set(effectiveHeads.map(({ paperFolderId }) => paperFolderId));
  if (state === 'present' && folderIds.size !== 1) {
    throw new PaperPresenceIntegrityError(
      'Concurrent present generations identify different paper folders.',
      documentId,
    );
  }
  const initialRoots = [...byId.values()].filter(
    (record) => record.generation.parents.length === 0,
  );
  if (initialRoots.length !== 1) {
    throw new PaperPresenceIntegrityError(
      'The paper-presence graph has ambiguous initial ancestry.',
      documentId,
    );
  }

  return {
    documentId,
    state,
    heads,
    headIds: heads.map(({ generation }) => generation.id),
    generationIds: [...byId.keys()].sort(compareCanonicalStrings),
    ...(folderIds.size === 1 ? { paperFolderId: [...folderIds][0] } : {}),
    displayName: effectiveHeads[0].displayName,
  };
}

export function assertPaperPresenceGeneration(
  value: unknown,
): asserts value is PaperPresenceGeneration {
  if (!isRecord(value)) throw invalidPresence();
  const generation = value.generation;
  const writer = value.writer;
  if (
    value.app !== '39Note' ||
    value.syncLayoutVersion !== SYNC_LAYOUT_VERSION ||
    value.presenceProtocolVersion !== PAPER_PRESENCE_PROTOCOL_VERSION ||
    !isSafeDriveId(value.rootFolderId) ||
    !isSafeDriveId(value.controlFolderId) ||
    !isValidDocumentId(value.documentId) ||
    !isSafeDisplayName(value.displayName) ||
    (value.state !== 'present' && value.state !== 'removed') ||
    !['migration', 'upload', 'remove', 'restore'].includes(String(value.intent)) ||
    !isSafeDriveId(value.paperFolderId) ||
    !isRecord(writer) ||
    !isSafeWriterId(writer.deviceId) ||
    (writer.deviceLabel !== undefined && !isSafeDeviceLabel(writer.deviceLabel)) ||
    !isRecord(generation) ||
    !isSha256(generation.id) ||
    !isTimestamp(generation.createdAt) ||
    generation.createdBy !== writer.deviceId ||
    !isSafeWriterId(generation.createdBy) ||
    !isSortedUniqueHashes(generation.parents)
  ) {
    throw invalidPresence(
      typeof value.documentId === 'string' ? value.documentId : undefined,
    );
  }
  const parents = generation.parents as string[];
  if (
    (value.intent === 'migration' && parents.length !== 0) ||
    (value.intent === 'upload' &&
      (value.state !== 'present' || parents.length !== 0)) ||
    (value.intent === 'remove' &&
      (value.state !== 'removed' || parents.length === 0)) ||
    (value.intent === 'restore' && (value.state !== 'present' || parents.length === 0))
  ) {
    throw invalidPresence(value.documentId as string);
  }
}

function assertValidPresenceTransitions(
  byId: ReadonlyMap<string, PaperPresenceGeneration>,
  documentId: string,
): void {
  for (const record of byId.values()) {
    if (record.intent === 'remove') {
      const parents = record.generation.parents.map((id) => byId.get(id)!);
      if (!parents.some((parent) => parent.state === 'present')) {
        throw new PaperPresenceIntegrityError(
          'A removal generation does not acknowledge a present parent.',
          documentId,
        );
      }
    }
    if (record.intent === 'restore') {
      const parents = record.generation.parents.map((id) => byId.get(id)!);
      if (!parents.some((parent) => parent.state === 'removed')) {
        throw new PaperPresenceIntegrityError(
          'A restore generation does not acknowledge a removal parent.',
          documentId,
        );
      }
    }
  }
}

function assertAcyclic(
  byId: ReadonlyMap<string, PaperPresenceGeneration>,
  documentId: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) {
      throw new PaperPresenceIntegrityError(
        'The paper-presence ancestry contains a cycle.',
        documentId,
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id)!.generation.parents) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function invalidPresence(documentId?: string): PaperPresenceIntegrityError {
  return new PaperPresenceIntegrityError(
    'A Drive paper-presence record is invalid or unsupported.',
    documentId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeDriveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function isSafeWriterId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/u.test(value);
}

function isSafeDeviceLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 80 &&
    !hasControlCharacters(value)
  );
}

function isSafeDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 180 &&
    !hasControlCharacters(value)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSortedUniqueHashes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isSha256) &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry)
  );
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 31);
}
