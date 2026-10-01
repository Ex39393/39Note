import {
  DOCUMENT_MIME_TYPES,
  getDocumentMimeType,
  type StoredDocumentSource,
} from '../types/document.ts';
import type { LocalPaperPackage, PaperCloudManifest } from './paperTypes.ts';
import type { LocalSyncSourceArtifact, SyncSourceArtifactDescriptor } from './types.ts';

export type PaperSourceDriveRole = 'paper-source-pdf' | 'paper-source-document';

export type ExactPaperSourceArtifact = SyncSourceArtifactDescriptor & {
  fileId: string;
  driveRole: PaperSourceDriveRole;
};

export function sourceArtifactFromManifest(
  manifest: PaperCloudManifest,
): ExactPaperSourceArtifact | undefined {
  if (manifest.syncLayoutVersion === 3) return manifest.sourceArtifact;
  const legacy = manifest.sourcePdf;
  return legacy
    ? {
        ...legacy,
        documentType: 'pdf',
        mimeType: DOCUMENT_MIME_TYPES.pdf,
        driveRole: 'paper-source-pdf',
      }
    : undefined;
}

export function sourceArtifactFromLocalPackage(
  local: LocalPaperPackage,
): LocalSyncSourceArtifact | undefined {
  if (local.sourceArtifact) return local.sourceArtifact;
  const legacy = local.sourcePdf;
  return legacy
    ? {
        ...legacy,
        documentType: 'pdf',
        mimeType: DOCUMENT_MIME_TYPES.pdf,
        ...(legacy.fileId ? { driveRole: 'paper-source-pdf' as const } : {}),
      }
    : undefined;
}

export function withoutSourceBlob(
  source: LocalSyncSourceArtifact,
): SyncSourceArtifactDescriptor {
  const { blob, ...descriptor } = source;
  void blob;
  return descriptor;
}

export function driveRoleForNewSource(
  source: Pick<SyncSourceArtifactDescriptor, 'documentType'>,
): PaperSourceDriveRole {
  // Keeping the established PDF-only role for actual PDFs preserves current
  // Drive behavior. Office sources always use the generic role and can never be
  // mistaken for a PDF by metadata validation.
  return source.documentType === 'pdf' ? 'paper-source-pdf' : 'paper-source-document';
}

export function sourceArtifactsHaveSameIdentity(
  first: Pick<
    SyncSourceArtifactDescriptor,
    'documentId' | 'documentType' | 'mimeType' | 'sha256' | 'size'
  >,
  second: Pick<
    SyncSourceArtifactDescriptor,
    'documentId' | 'documentType' | 'mimeType' | 'sha256' | 'size'
  >,
): boolean {
  return (
    first.documentId === second.documentId &&
    first.documentType === second.documentType &&
    first.mimeType === second.mimeType &&
    first.sha256 === second.sha256 &&
    first.size === second.size
  );
}

export function sourceArtifactCacheKey(
  source: ExactPaperSourceArtifact,
  paperFolderId: string,
): string {
  return [
    source.documentId,
    paperFolderId,
    source.fileId,
    source.driveRole,
    source.documentType,
    source.sha256,
    source.size,
  ].join(':');
}

export function storedSourceFromDescriptor(
  descriptor: SyncSourceArtifactDescriptor,
  blob: Blob,
): StoredDocumentSource {
  return {
    documentId: descriptor.documentId,
    documentType: descriptor.documentType,
    fileName: descriptor.fileName,
    mimeType: getDocumentMimeType(descriptor.documentType),
    sha256: descriptor.sha256,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
    storedAt: descriptor.storedAt,
    blob,
  };
}
