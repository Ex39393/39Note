import type { DriveFileMetadata } from './driveClient.ts';
import { DOCUMENT_MIME_TYPES } from '../types/document.ts';
import { isSha256, sha256Hex, stableStringify } from './hash.ts';
import {
  PAPER_PRESENCE_PROTOCOL_VERSION,
  PAPER_PRESENCE_ROLE,
  PAPER_V3_CONTROL_NAME,
  PAPER_V3_CONTROL_ROLE,
  PAPER_V3_DESCRIPTOR_ROLE,
  PAPER_V3_MIGRATION_ROLE,
} from './paperPresence.ts';
import {
  LEGACY_PAPER_MANIFEST_STORAGE,
  LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_MANIFEST_STORAGE,
  PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_SYNC_PROTOCOL_VERSION,
  SYNC_LAYOUT_VERSION,
} from './paperTypes.ts';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const IMMUTABLE_LEGACY_MANIFEST_STORAGE = 'immutable-manifest-v1';

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
]);

const PAPER_V3_CONTROL_ROLES = new Set([
  PAPER_V3_CONTROL_ROLE,
  PAPER_V3_DESCRIPTOR_ROLE,
  PAPER_PRESENCE_ROLE,
  PAPER_V3_MIGRATION_ROLE,
]);

const LEGACY_ROLES = new Set([
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
]);

export type LegacyDriveItemClassification =
  'current-paper-v2' | 'current-layout-v3' | 'recognized-legacy' | 'unknown';

export interface LegacyDriveTreeEntry {
  file: DriveFileMetadata;
  depth: number;
}

/** Safe presentation plus opaque evidence used to revalidate before Trash. */
export interface LegacyDriveInventoryItem {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  role?: string;
  classification: LegacyDriveItemClassification;
  reason: string;
  cleanupEligible: boolean;
  cleanupDisposition: string;
  depth: number;
  evidenceHash: string;
}

export interface LegacyDriveInventory {
  inventoryId: string;
  rootFolderId: string;
  scannedAt: number;
  currentPaperCount: number;
  recognizedLegacyCount: number;
  unknownCount: number;
  cleanupEligibleCount: number;
  /** Only currently active leaf items are targeted; folders are reconsidered once empty. */
  cleanupTargetIds: string[];
  cleanupBlockedReason?: string;
  items: LegacyDriveInventoryItem[];
}

export interface LegacyDriveInventoryOptions {
  activePaperLayout: boolean;
  currentDataVerified: boolean;
  migrationActivationVerified?: boolean;
  supersededLegacyFileIds?: readonly string[];
  currentReferenceIds?: readonly string[];
  protectedLegacyFileIds?: readonly string[];
  migrationInProgress?: boolean;
  now?: number;
}

export interface LegacyDriveCleanupResult {
  inventory: LegacyDriveInventory;
  trashedIds: string[];
}

interface ClassificationEvidence {
  classification: LegacyDriveItemClassification;
  reason: string;
}

export async function buildLegacyDriveInventory(
  rootFolderId: string,
  entries: readonly LegacyDriveTreeEntry[],
  options: LegacyDriveInventoryOptions,
): Promise<LegacyDriveInventory> {
  const deduped = dedupeEntries(entries);
  const paperV3ControlFolderIds = new Set(
    deduped
      .filter(({ file }) => isCurrentV3ControlFolder(file, rootFolderId))
      .map(({ file }) => file.id),
  );
  const paperFolders = new Map<string, string>();
  for (const { file } of deduped) {
    if (
      isCurrentPaperRole(file, 'paper-folder') &&
      file.mimeType === FOLDER_MIME &&
      exactParent(file, rootFolderId) &&
      validDocumentId(file.appProperties?.documentId)
    ) {
      paperFolders.set(file.id, file.appProperties!.documentId);
    }
  }
  const paperDataFolders = new Map<string, string>();
  for (const { file } of deduped) {
    const parentId = exactParentId(file);
    const documentId = parentId ? paperFolders.get(parentId) : undefined;
    if (
      documentId &&
      isCurrentPaperRole(file, 'paper-data', documentId) &&
      file.mimeType === FOLDER_MIME &&
      file.name === '39Note Data'
    ) {
      paperDataFolders.set(file.id, documentId);
    }
  }

  const legacyDocumentsFolders = deduped.filter(
    ({ file }) =>
      isLegacyOwnedRole(file, 'documents') &&
      file.mimeType === FOLDER_MIME &&
      file.name === 'documents' &&
      exactParent(file, rootFolderId),
  );
  const legacyDocumentFolders = new Map<string, string>();
  for (const { file } of deduped) {
    const parentId = exactParentId(file);
    if (
      !parentId ||
      !legacyDocumentsFolders.some(({ file: parent }) => parent.id === parentId)
    ) {
      continue;
    }
    const documentId = file.appProperties?.documentId;
    if (
      isLegacyOwnedRole(file, 'document') &&
      file.mimeType === FOLDER_MIME &&
      validDocumentId(documentId) &&
      file.name === legacyDocumentFolderName(documentId)
    ) {
      legacyDocumentFolders.set(file.id, documentId);
    }
  }

  const classifications = new Map<string, ClassificationEvidence>();
  for (const { file } of deduped) {
    classifications.set(
      file.id,
      classifyItem(
        file,
        rootFolderId,
        paperV3ControlFolderIds,
        paperFolders,
        paperDataFolders,
        legacyDocumentsFolders.map(({ file: folder }) => folder.id),
        legacyDocumentFolders,
      ),
    );
  }

  const currentReferences = new Set(options.currentReferenceIds ?? []);
  const protectedLegacyIds = new Set(options.protectedLegacyFileIds ?? []);
  const supersededLegacyIds = new Set(options.supersededLegacyFileIds ?? []);
  const globallyBlockedReason = cleanupBlockedReason(options);
  const eligibility = new Map<string, boolean>();
  const cleanupDispositions = new Map<string, string>();
  for (const { file } of deduped) {
    const classification = classifications.get(file.id)!;
    let eligible = false;
    let disposition: string;
    if (classification.classification === 'current-paper-v2') {
      disposition = 'Current paper package data is always preserved.';
    } else if (classification.classification === 'current-layout-v3') {
      disposition = 'Current paper-v3 control data is always preserved.';
    } else if (classification.classification === 'unknown') {
      disposition = 'Unknown or unclassified data is always preserved.';
    } else if (globallyBlockedReason) {
      disposition = globallyBlockedReason;
    } else if (currentReferences.has(file.id)) {
      disposition =
        'Preserved because current paper package data references this item.';
    } else if (protectedLegacyIds.has(file.id)) {
      disposition =
        'Preserved because migration or recovery still references this item.';
    } else if (file.mimeType === FOLDER_MIME) {
      disposition =
        'Legacy folders are preserved so Drive Trash cannot affect contents added concurrently.';
    } else if (!supersededLegacyIds.has(file.id)) {
      disposition =
        'Preserved because verified migration evidence does not prove this item obsolete.';
    } else {
      eligible = true;
      disposition = 'Eligible for Drive Trash after explicit confirmation.';
    }
    eligibility.set(file.id, eligible);
    cleanupDispositions.set(file.id, disposition);
  }

  if (legacyDocumentsFolders.length !== 1 && legacyDocumentsFolders.length > 0) {
    for (const { file } of legacyDocumentsFolders) {
      markSubtreeIneligible(
        file.id,
        deduped,
        eligibility,
        cleanupDispositions,
        'Preserved because more than one legacy documents folder makes its identity ambiguous.',
      );
    }
  }
  const legacyDocumentsById = new Map<string, string[]>();
  for (const [folderId, documentId] of legacyDocumentFolders) {
    legacyDocumentsById.set(documentId, [
      ...(legacyDocumentsById.get(documentId) ?? []),
      folderId,
    ]);
  }
  for (const duplicateIds of legacyDocumentsById.values()) {
    if (duplicateIds.length < 2) continue;
    for (const folderId of duplicateIds) {
      markSubtreeIneligible(
        folderId,
        deduped,
        eligibility,
        cleanupDispositions,
        'Preserved because more than one legacy document folder claims the same paper identity.',
      );
    }
  }
  const legacyIdentityGroups = new Map<string, string[]>();
  for (const { file } of deduped) {
    if (classifications.get(file.id)?.classification !== 'recognized-legacy') {
      continue;
    }
    const identity = stableStringify({
      parent: exactParentId(file) ?? null,
      name: file.name,
      role: file.appProperties?.role ?? null,
      documentId: file.appProperties?.documentId ?? null,
      sha256: file.appProperties?.sha256 ?? null,
      generationId: file.appProperties?.generationId ?? null,
    });
    legacyIdentityGroups.set(identity, [
      ...(legacyIdentityGroups.get(identity) ?? []),
      file.id,
    ]);
  }
  for (const ambiguousIds of legacyIdentityGroups.values()) {
    if (ambiguousIds.length < 2) continue;
    for (const id of ambiguousIds) {
      markSubtreeIneligible(
        id,
        deduped,
        eligibility,
        cleanupDispositions,
        'Preserved because duplicate legacy identity metadata is ambiguous.',
      );
    }
  }

  const items = await Promise.all(
    deduped.map(async ({ file, depth }): Promise<LegacyDriveInventoryItem> => {
      const classified = classifications.get(file.id)!;
      return {
        id: file.id,
        name: safeDisplayName(file.name),
        kind: file.mimeType === FOLDER_MIME ? 'folder' : 'file',
        ...(safeRole(file.appProperties?.role)
          ? { role: safeRole(file.appProperties?.role) }
          : {}),
        ...classified,
        cleanupEligible: eligibility.get(file.id) === true,
        cleanupDisposition:
          cleanupDispositions.get(file.id) ??
          'Preserved because eligibility is uncertain.',
        depth,
        evidenceHash: await driveMetadataEvidenceHash(file),
      };
    }),
  );
  items.sort(
    (first, second) =>
      first.depth - second.depth ||
      first.classification.localeCompare(second.classification) ||
      first.name.localeCompare(second.name) ||
      first.id.localeCompare(second.id),
  );

  const cleanupTargetIds = items
    .filter((item) => item.cleanupEligible && item.kind === 'file')
    .map(({ id }) => id)
    .sort();
  const inventoryEvidence = items.map(({ id, evidenceHash, cleanupEligible }) => ({
    id,
    evidenceHash,
    cleanupEligible,
  }));
  const inventoryId = await sha256Hex(
    stableStringify({
      rootFolderId,
      activePaperLayout: options.activePaperLayout,
      currentDataVerified: options.currentDataVerified,
      migrationInProgress: options.migrationInProgress === true,
      migrationActivationVerified: options.migrationActivationVerified === true,
      protectedLegacyFileIds: [...protectedLegacyIds].sort(),
      currentReferenceIds: [...currentReferences].sort(),
      supersededLegacyFileIds: [...supersededLegacyIds].sort(),
      items: inventoryEvidence,
    }),
  );

  return {
    inventoryId,
    rootFolderId,
    scannedAt: options.now ?? Date.now(),
    currentPaperCount: items.filter(({ classification }) =>
      isCurrentClassification(classification),
    ).length,
    recognizedLegacyCount: items.filter(
      ({ classification }) => classification === 'recognized-legacy',
    ).length,
    unknownCount: items.filter(({ classification }) => classification === 'unknown')
      .length,
    cleanupEligibleCount: items.filter(({ cleanupEligible }) => cleanupEligible).length,
    cleanupTargetIds,
    ...(globallyBlockedReason ? { cleanupBlockedReason: globallyBlockedReason } : {}),
    items,
  };
}

export async function driveMetadataEvidenceHash(
  file: DriveFileMetadata,
): Promise<string> {
  return sha256Hex(
    stableStringify({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: [...(file.parents ?? [])].sort(),
      appProperties: file.appProperties ?? {},
      modifiedTime: file.modifiedTime ?? null,
      version: file.version ?? null,
      size: file.size ?? null,
      md5Checksum: file.md5Checksum ?? null,
      trashed: file.trashed === true,
      ownedByMe: file.ownedByMe === true,
    }),
  );
}

function classifyItem(
  file: DriveFileMetadata,
  rootFolderId: string,
  paperV3ControlFolderIds: ReadonlySet<string>,
  paperFolders: ReadonlyMap<string, string>,
  paperDataFolders: ReadonlyMap<string, string>,
  legacyDocumentsFolderIds: readonly string[],
  legacyDocumentFolders: ReadonlyMap<string, string>,
): ClassificationEvidence {
  const controlReason = currentV3ControlReason(
    file,
    rootFolderId,
    paperV3ControlFolderIds,
  );
  if (controlReason) {
    return { classification: 'current-layout-v3', reason: controlReason };
  }
  const currentReason = currentPaperReason(
    file,
    rootFolderId,
    paperFolders,
    paperDataFolders,
  );
  if (currentReason) {
    return { classification: 'current-paper-v2', reason: currentReason };
  }
  const legacyReason = recognizedLegacyReason(
    file,
    rootFolderId,
    new Set(legacyDocumentsFolderIds),
    legacyDocumentFolders,
  );
  if (legacyReason) {
    return { classification: 'recognized-legacy', reason: legacyReason };
  }
  if (looksLikeManagedName(file.name) && file.appProperties?.application !== '39Note') {
    return {
      classification: 'unknown',
      reason:
        'The name resembles 39Note data, but trusted ownership metadata is absent.',
    };
  }
  if (
    file.appProperties?.application === '39Note' &&
    (PAPER_ROLES.has(file.appProperties.role) ||
      PAPER_V3_CONTROL_ROLES.has(file.appProperties.role) ||
      LEGACY_ROLES.has(file.appProperties.role))
  ) {
    return {
      classification: 'unknown',
      reason: '39Note metadata is incomplete, malformed, or in an unexpected location.',
    };
  }
  return {
    classification: 'unknown',
    reason: 'No trusted 39Note layout identity was found; this item is preserved.',
  };
}

function currentPaperReason(
  file: DriveFileMetadata,
  rootFolderId: string,
  paperFolders: ReadonlyMap<string, string>,
  paperDataFolders: ReadonlyMap<string, string>,
): string | null {
  const role = file.appProperties?.role;
  if (!role || !isCurrentPaperRole(file, role)) return null;
  const packageLayoutVersion = currentPaperPackageLayoutVersion(file);
  if (packageLayoutVersion === undefined) return null;
  const parentId = exactParentId(file);
  if (role === 'paper-folder') {
    return file.mimeType === FOLDER_MIME &&
      exactParent(file, rootFolderId) &&
      validDocumentId(file.appProperties?.documentId)
      ? 'Verified current paper package folder.'
      : null;
  }
  if (role === 'paper-layout-activation') {
    const sha = file.appProperties?.sha256;
    return file.mimeType === 'application/json' &&
      exactParent(file, rootFolderId) &&
      file.appProperties?.documentId === 'layout' &&
      isSha256(sha) &&
      file.name === `paper-layout-v${packageLayoutVersion}-${sha}.json`
      ? 'Verified current paper package layout activation record.'
      : null;
  }
  const paperDocumentId = parentId ? paperFolders.get(parentId) : undefined;
  if (role === 'paper-data') {
    return paperDocumentId &&
      file.mimeType === FOLDER_MIME &&
      file.name === '39Note Data' &&
      file.appProperties?.documentId === paperDocumentId
      ? 'Verified current paper package data folder.'
      : null;
  }
  if (
    role === 'paper-source-pdf' ||
    role === 'paper-source-document' ||
    role === 'paper-rendered-print-pdf'
  ) {
    return paperDocumentId &&
      (role !== 'paper-source-document' ||
        packageLayoutVersion === PAPER_PACKAGE_LAYOUT_VERSION) &&
      (role === 'paper-source-document'
        ? file.mimeType === DOCUMENT_MIME_TYPES.docx ||
          file.mimeType === DOCUMENT_MIME_TYPES.pptx
        : file.mimeType === 'application/pdf') &&
      file.appProperties?.documentId === paperDocumentId &&
      isSha256(file.appProperties.sha256)
      ? role === 'paper-source-pdf'
        ? 'Verified current source PDF.'
        : role === 'paper-source-document'
          ? 'Verified current typed source document.'
          : 'Verified current rendered Print PDF.'
      : null;
  }
  const dataDocumentId = parentId ? paperDataFolders.get(parentId) : undefined;
  if (!dataDocumentId || file.appProperties?.documentId !== dataDocumentId) return null;
  const sha = file.appProperties.sha256;
  if (role === 'paper-manifest-generation') {
    const generationId = file.appProperties.generationId;
    const expectedManifestStorage =
      packageLayoutVersion === LEGACY_PAPER_PACKAGE_LAYOUT_VERSION
        ? LEGACY_PAPER_MANIFEST_STORAGE
        : PAPER_MANIFEST_STORAGE;
    return file.mimeType === 'application/json' &&
      file.appProperties.manifestStorage === expectedManifestStorage &&
      isSha256(generationId) &&
      file.name ===
        `paper-manifest-v${PAPER_SYNC_PROTOCOL_VERSION}-${generationId}.json`
      ? 'Verified current immutable paper manifest.'
      : null;
  }
  const baseName =
    role === 'paper-state'
      ? 'state.json'
      : role === 'paper-productivity'
        ? 'productivity.json'
        : role === 'paper-conflicts'
          ? 'conflicts.json'
          : null;
  return baseName &&
    file.mimeType === 'application/json' &&
    isSha256(sha) &&
    file.name === generatedJsonName(baseName, sha)
    ? `Verified current ${role.replace('paper-', '')} payload.`
    : null;
}

function currentV3ControlReason(
  file: DriveFileMetadata,
  rootFolderId: string,
  controlFolderIds: ReadonlySet<string>,
): string | null {
  const role = file.appProperties?.role;
  if (!role || !PAPER_V3_CONTROL_ROLES.has(role)) return null;
  if (role === PAPER_V3_CONTROL_ROLE) {
    return isCurrentV3ControlFolder(file, rootFolderId)
      ? 'Verified current paper-v3 control folder.'
      : null;
  }
  const parentId = exactParentId(file);
  if (
    !parentId ||
    !controlFolderIds.has(parentId) ||
    file.ownedByMe !== true ||
    file.trashed === true ||
    file.mimeType !== 'application/json' ||
    file.appProperties?.application !== '39Note' ||
    file.appProperties.role !== role ||
    file.appProperties.rootFolderId !== rootFolderId ||
    file.appProperties.controlFolderId !== parentId
  ) {
    return null;
  }
  if (role === PAPER_V3_DESCRIPTOR_ROLE) {
    const sha = file.appProperties.sha256;
    return isSha256(sha) && file.name === `paper-v3-layout-${sha}.json`
      ? 'Verified current paper-v3 layout descriptor.'
      : null;
  }
  if (role === PAPER_V3_MIGRATION_ROLE) {
    const completionId = file.appProperties.completionId;
    return isSha256(completionId) &&
      file.name === `paper-v3-migration-${completionId}.json`
      ? 'Verified current paper-v3 migration completion.'
      : null;
  }
  const generationId = file.appProperties.generationId;
  const state = file.appProperties.state;
  return role === PAPER_PRESENCE_ROLE &&
    validDocumentId(file.appProperties.documentId) &&
    (state === 'present' || state === 'removed') &&
    file.appProperties.presenceProtocolVersion ===
      String(PAPER_PRESENCE_PROTOCOL_VERSION) &&
    isSha256(generationId) &&
    file.name === `paper-presence-${generationId}.json`
    ? 'Verified current immutable paper-presence record.'
    : null;
}

function isCurrentV3ControlFolder(
  file: DriveFileMetadata,
  rootFolderId: string,
): boolean {
  const properties = file.appProperties;
  return (
    file.ownedByMe === true &&
    file.trashed !== true &&
    file.mimeType === FOLDER_MIME &&
    file.name === PAPER_V3_CONTROL_NAME &&
    exactParent(file, rootFolderId) &&
    properties?.application === '39Note' &&
    properties.role === PAPER_V3_CONTROL_ROLE &&
    properties.rootFolderId === rootFolderId &&
    properties.layoutVersion === String(SYNC_LAYOUT_VERSION) &&
    properties.paperProtocolVersion === String(PAPER_SYNC_PROTOCOL_VERSION) &&
    properties.presenceProtocolVersion === String(PAPER_PRESENCE_PROTOCOL_VERSION)
  );
}

function isCurrentClassification(
  classification: LegacyDriveItemClassification,
): boolean {
  return (
    classification === 'current-paper-v2' || classification === 'current-layout-v3'
  );
}

function recognizedLegacyReason(
  file: DriveFileMetadata,
  rootFolderId: string,
  documentsFolderIds: ReadonlySet<string>,
  documentFolders: ReadonlyMap<string, string>,
): string | null {
  const role = file.appProperties?.role;
  if (!role || !isLegacyOwnedRole(file, role)) return null;
  const parentId = exactParentId(file);
  if (role === 'readme') {
    return exactParent(file, rootFolderId) &&
      file.mimeType === 'text/plain' &&
      file.name === 'README.txt'
      ? 'Verified app-owned global-v1 readme.'
      : null;
  }
  if (role === 'documents') {
    return exactParent(file, rootFolderId) &&
      file.mimeType === FOLDER_MIME &&
      file.name === 'documents'
      ? 'Verified app-owned global-v1 documents folder.'
      : null;
  }
  if (role === 'document') {
    const documentId = file.appProperties?.documentId;
    return parentId &&
      documentsFolderIds.has(parentId) &&
      file.mimeType === FOLDER_MIME &&
      validDocumentId(documentId) &&
      file.name === legacyDocumentFolderName(documentId)
      ? 'Verified app-owned global-v1 document folder.'
      : null;
  }
  if (['manifest', 'manifest-generation', 'library', 'ai-settings'].includes(role)) {
    if (!exactParent(file, rootFolderId) || file.mimeType !== 'application/json') {
      return null;
    }
    if (role === 'manifest') {
      return file.name === '39note-manifest.json'
        ? 'Verified app-owned mutable global-v1 manifest.'
        : null;
    }
    if (role === 'manifest-generation') {
      const generationId = file.appProperties?.generationId;
      return file.appProperties?.manifestStorage ===
        IMMUTABLE_LEGACY_MANIFEST_STORAGE &&
        isSha256(generationId) &&
        file.name === `39note-manifest-v1-${generationId}.json`
        ? 'Verified app-owned immutable global-v1 manifest.'
        : null;
    }
    const baseName = role === 'library' ? 'library.json' : 'ai-settings.json';
    return matchesLegacyJsonPayload(file, baseName)
      ? `Verified app-owned global-v1 ${role.replace('-', ' ')} payload.`
      : null;
  }
  const legacyDocumentId = parentId ? documentFolders.get(parentId) : undefined;
  if (!legacyDocumentId) return null;
  if (role === 'state' || role === 'productivity') {
    const metadataDocumentId = file.appProperties?.documentId;
    if (metadataDocumentId !== undefined && metadataDocumentId !== legacyDocumentId) {
      return null;
    }
    const baseName = role === 'state' ? 'state.json' : 'productivity.json';
    return file.mimeType === 'application/json' &&
      matchesLegacyJsonPayload(file, baseName)
      ? `Verified app-owned global-v1 ${role} payload.`
      : null;
  }
  if (role === 'original-pdf') {
    if (file.appProperties?.documentId !== legacyDocumentId) return null;
    const sha = file.appProperties?.sha256;
    return (file.mimeType === 'application/pdf' ||
      file.mimeType === 'application/octet-stream') &&
      isSha256(sha) &&
      (file.name === 'original.pdf' || file.name === `original-${sha.slice(0, 16)}.pdf`)
      ? 'Verified app-owned global-v1 source PDF.'
      : null;
  }
  return null;
}

function isCurrentPaperRole(
  file: DriveFileMetadata,
  role: string,
  documentId?: string,
): boolean {
  return (
    file.ownedByMe === true &&
    file.trashed !== true &&
    file.appProperties?.application === '39Note' &&
    file.appProperties.syncSchema === '1' &&
    currentPaperPackageLayoutVersion(file) !== undefined &&
    file.appProperties.paperProtocolVersion === String(PAPER_SYNC_PROTOCOL_VERSION) &&
    file.appProperties.role === role &&
    (!documentId || file.appProperties.documentId === documentId)
  );
}

function currentPaperPackageLayoutVersion(
  file: DriveFileMetadata,
):
  | typeof LEGACY_PAPER_PACKAGE_LAYOUT_VERSION
  | typeof PAPER_PACKAGE_LAYOUT_VERSION
  | undefined {
  const layoutVersion = file.appProperties?.layoutVersion;
  if (layoutVersion === String(LEGACY_PAPER_PACKAGE_LAYOUT_VERSION)) {
    return LEGACY_PAPER_PACKAGE_LAYOUT_VERSION;
  }
  if (layoutVersion === String(PAPER_PACKAGE_LAYOUT_VERSION)) {
    return PAPER_PACKAGE_LAYOUT_VERSION;
  }
  return undefined;
}

function isLegacyOwnedRole(file: DriveFileMetadata, role: string): boolean {
  return (
    file.ownedByMe === true &&
    file.trashed !== true &&
    file.appProperties?.application === '39Note' &&
    file.appProperties.syncSchema === '1' &&
    file.appProperties.layoutVersion === undefined &&
    file.appProperties.paperProtocolVersion === undefined &&
    file.appProperties.role === role &&
    LEGACY_ROLES.has(role)
  );
}

function matchesLegacyJsonPayload(file: DriveFileMetadata, baseName: string): boolean {
  if (file.name === baseName) return true;
  const sha = file.appProperties?.sha256;
  return isSha256(sha) && file.name === generatedJsonName(baseName, sha);
}

function generatedJsonName(baseName: string, sha: string): string {
  const stem = baseName.slice(0, -'.json'.length);
  return `${stem}-${sha.slice(0, 16)}.json`;
}

function legacyDocumentFolderName(documentId: string): string {
  return `document-${documentId.replace(/[^a-z0-9._-]/giu, '_').slice(0, 96)}`;
}

function validDocumentId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 512 && !hasControlCharacters(value));
}

function exactParent(file: DriveFileMetadata, parentId: string): boolean {
  return file.parents?.length === 1 && file.parents[0] === parentId;
}

function exactParentId(file: DriveFileMetadata): string | undefined {
  return file.parents?.length === 1 ? file.parents[0] : undefined;
}

function groupDirectChildren(
  entries: readonly LegacyDriveTreeEntry[],
): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const { file } of entries) {
    const parentId = exactParentId(file);
    if (!parentId) continue;
    children.set(parentId, [...(children.get(parentId) ?? []), file.id]);
  }
  return children;
}

function markSubtreeIneligible(
  rootId: string,
  entries: readonly LegacyDriveTreeEntry[],
  eligibility: Map<string, boolean>,
  dispositions: Map<string, string>,
  reason: string,
): void {
  const children = groupDirectChildren(entries);
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    eligibility.set(id, false);
    dispositions.set(id, reason);
    pending.push(...(children.get(id) ?? []));
  }
}

function cleanupBlockedReason(
  options: LegacyDriveInventoryOptions,
): string | undefined {
  if (!options.activePaperLayout) {
    return 'Cleanup is unavailable until the current Drive layout is active.';
  }
  if (options.migrationInProgress) {
    return 'Cleanup is unavailable while migration or recovery evidence is active.';
  }
  if (!options.currentDataVerified) {
    return 'Cleanup is unavailable because current paper data could not be verified.';
  }
  if (!options.migrationActivationVerified) {
    return 'Cleanup is unavailable because completed Drive migration evidence could not be verified.';
  }
  return undefined;
}

function dedupeEntries(
  entries: readonly LegacyDriveTreeEntry[],
): LegacyDriveTreeEntry[] {
  const byId = new Map<string, LegacyDriveTreeEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.file.id);
    if (!existing || entry.depth < existing.depth) byId.set(entry.file.id, entry);
  }
  return [...byId.values()];
}

function safeDisplayName(name: string): string {
  const trimmed = Array.from(name)
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x1f)
    .join('')
    .trim();
  return (trimmed || 'Unnamed item').slice(0, 160);
}

function safeRole(role: string | undefined): string | undefined {
  return role && /^[a-z0-9-]{1,64}$/u.test(role) ? role : undefined;
}

function looksLikeManagedName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === 'documents' ||
    normalized === '39note data' ||
    normalized.startsWith('39note-manifest') ||
    normalized.startsWith('paper-manifest') ||
    normalized.startsWith('document-') ||
    ['library.json', 'ai-settings.json', 'state.json', 'productivity.json'].includes(
      normalized,
    )
  );
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
}
