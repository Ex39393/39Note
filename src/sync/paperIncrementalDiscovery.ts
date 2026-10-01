import type { DriveChange } from './driveClient.ts';
import type { PaperCloudSummary } from './paperTypes.ts';

const PAPER_ROLES = new Set([
  'paper-folder',
  'paper-data',
  'paper-state',
  'paper-productivity',
  'paper-conflicts',
  'paper-manifest-generation',
  'paper-presence-generation',
  'paper-source-pdf',
  'paper-rendered-print-pdf',
]);

const STRUCTURAL_ROLES = new Set([
  'root',
  'paper-layout-activation',
  'paper-v3-control',
  'paper-v3-layout-descriptor',
  'paper-v3-migration-completion',
  'documents',
  'document',
  'manifest',
  'manifest-generation',
  'library',
  'ai-settings',
]);

export type PaperFullAuditReason =
  | 'root-changed'
  | 'unknown-removal'
  | 'managed-structure-changed'
  | 'malformed-managed-change';

export interface PaperChangePlan {
  affectedDocumentIds: string[];
  removedManagedFiles: Array<{ documentId: string; fileId: string }>;
  requiresFullAudit: boolean;
  reasons: PaperFullAuditReason[];
}

/**
 * The Drive change feed is an invalidation index only. This planner never treats
 * a change record as a head or as verified cloud state.
 */
export function planPaperChangeDiscovery(
  changes: readonly DriveChange[],
  rootFolderId: string,
  cachedPapers: readonly PaperCloudSummary[],
): PaperChangePlan {
  const documentByFileId = new Map<string, string>();
  for (const paper of cachedPapers) {
    const ids = [
      paper.paperFolderId,
      paper.dataFolderId,
      paper.sourcePdf?.fileId,
      paper.renderedPrintPdf?.fileId,
      ...(paper.managedFileIds ?? []),
    ];
    for (const id of ids) if (id) documentByFileId.set(id, paper.documentId);
  }

  const affected = new Set<string>();
  const removedManagedFiles = new Map<string, string>();
  const reasons = new Set<PaperFullAuditReason>();
  for (const change of changes) {
    const knownDocumentId = documentByFileId.get(change.fileId);
    if (change.fileId === rootFolderId) {
      reasons.add('root-changed');
      continue;
    }
    if (change.removed || change.file?.trashed === true) {
      if (knownDocumentId) {
        affected.add(knownDocumentId);
        removedManagedFiles.set(change.fileId, knownDocumentId);
      } else reasons.add('unknown-removal');
      continue;
    }
    const file = change.file;
    if (!file) {
      reasons.add('malformed-managed-change');
      continue;
    }
    if (knownDocumentId) affected.add(knownDocumentId);
    const properties = file.appProperties;
    if (properties?.application !== '39Note') continue;
    const role = properties.role;
    if (!role) {
      reasons.add('malformed-managed-change');
      continue;
    }
    if (STRUCTURAL_ROLES.has(role)) {
      reasons.add(role === 'root' ? 'root-changed' : 'managed-structure-changed');
      continue;
    }
    if (!PAPER_ROLES.has(role)) {
      reasons.add('managed-structure-changed');
      continue;
    }
    const documentId = properties.documentId;
    if (!documentId || documentId.length > 512 || hasControlCharacters(documentId)) {
      reasons.add('malformed-managed-change');
      continue;
    }
    affected.add(documentId);
  }
  return {
    affectedDocumentIds: [...affected].sort(),
    removedManagedFiles: [...removedManagedFiles]
      .map(([fileId, documentId]) => ({ documentId, fileId }))
      .sort(
        (first, second) =>
          first.documentId.localeCompare(second.documentId) ||
          first.fileId.localeCompare(second.fileId),
      ),
    requiresFullAudit: reasons.size > 0,
    reasons: [...reasons].sort(),
  };
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
}
