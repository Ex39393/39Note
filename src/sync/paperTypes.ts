import type { StoredPdfFile } from '../services/annotationPersistence.ts';
import type { StoredDocumentSource } from '../types/document.ts';
import type { StoredRenderedPrintPdf } from '../types/productivity.ts';
import type {
  CloudManifestRecoveryEvidence,
  CloudPayloadReference,
} from './cloudFormat.ts';
import type {
  LocalSyncPdf,
  LocalSyncSourceArtifact,
  PdfFingerprintCacheEntry,
  SyncConflict,
  SyncEntityVersion,
  SyncPdfDescriptor,
  SyncSourceArtifactDescriptor,
  SyncSnapshot,
  SyncTombstone,
} from './types.ts';

export const SYNC_LAYOUT_VERSION = 3 as const;
/** Existing immutable package-v2 bytes remain valid and are never rewritten. */
export const LEGACY_PAPER_PACKAGE_LAYOUT_VERSION = 2 as const;
export const PAPER_PACKAGE_LAYOUT_VERSION = 3 as const;
export const PAPER_SYNC_PROTOCOL_VERSION = 2 as const;
export const LEGACY_PAPER_MANIFEST_STORAGE = 'immutable-paper-manifest-v2' as const;
export const PAPER_MANIFEST_STORAGE = 'immutable-paper-manifest-v3' as const;
/** Entity partitioning is unchanged by the source-artifact layout migration. */
export const PAPER_PAYLOAD_STORAGE = 'immutable-paper-payload-v2' as const;

export type SupportedPaperPackageLayoutVersion =
  typeof LEGACY_PAPER_PACKAGE_LAYOUT_VERSION | typeof PAPER_PACKAGE_LAYOUT_VERSION;

export type PaperDirtyReason =
  | 'metadata'
  | 'source-pdf'
  | 'source-document'
  | 'notes'
  | 'annotations'
  | 'glossary'
  | 'reading-state'
  | 'print-draft'
  | 'deleted'
  | 'rendered-print-pdf'
  | 'ai-conversation';

export type PaperAvailability = 'cloud-only' | 'local-only' | 'local-and-cloud';

/** Local proof that a previously verified immutable Drive file is still identical. */
export interface PaperDriveFileEvidence {
  fileId: string;
  version: string;
  md5Checksum: string;
  size: string;
}

export type PaperSyncStatus =
  | 'cloud-only'
  | 'local-only'
  | 'synced'
  | 'local-changes'
  | 'remote-update-available'
  | 'both-changed'
  | 'downloading'
  | 'uploading'
  | 'needs-attention';

export interface PaperDriveFileCache {
  paperFolderId?: string;
  dataFolderId?: string;
  sourcePdfFileId?: string;
  sourcePdfEvidence?: PaperDriveFileEvidence;
  sourceArtifactFileId?: string;
  sourceArtifactEvidence?: PaperDriveFileEvidence;
  renderedPrintPdfFileId?: string;
  fileIds: Record<string, string>;
}

export interface PaperSyncState {
  documentId: string;
  /** Presentation only. Identity remains documentId. */
  displayName?: string;
  /** Local writer identity; never shown directly in the normal UI. */
  deviceId: string;
  availability: PaperAvailability;
  status: PaperSyncStatus;
  dirtyGeneration: number;
  dirtyReasons: PaperDirtyReason[];
  locallyDeleted?: boolean;
  entityVersions: Record<string, SyncEntityVersion>;
  baselineHashes: Record<string, string>;
  tombstones: SyncTombstone[];
  conflicts: SyncConflict[];
  incorporatedHeadIds: string[];
  remoteHeadIds: string[];
  /** Exact authoritative package-head set explicitly dismissed on this device. */
  dismissedRemoteHeadIds?: string[];
  pdfFingerprints: Record<string, PdfFingerprintCacheEntry>;
  /** Layout-3 generic source fingerprints. Legacy PDF entries remain readable. */
  sourceFingerprints?: Record<string, PdfFingerprintCacheEntry>;
  driveFiles: PaperDriveFileCache;
  /** Layout-v3 cloud presence authority; omitted for never-uploaded/v2 state. */
  cloudPresence?: 'present' | 'removed';
  presenceHeadIds?: string[];
  /** Logical removal succeeded, but the exact old folder still needs Drive Trash. */
  cloudCleanupPending?: boolean;
  lastSuccessfulAt?: number;
  temporarySessionId?: string;
}

export interface PaperWriterMetadata {
  deviceId: string;
  deviceLabel?: string;
}

export interface PaperManifestGeneration {
  /** SHA-256 of the canonical manifest with this field omitted. */
  id: string;
  /** Informational client time only. It is not used to select a head. */
  createdAt: number;
  createdBy: string;
  parents: string[];
}

export interface RenderedPrintPdfDescriptor {
  kind: 'rendered-print-pdf';
  documentId: string;
  fileId: string;
  fileName: string;
  mimeType: 'application/pdf';
  size: number;
  sha256: string;
  renderedFromDraftHash: string;
  createdAt: number;
}

interface PaperCloudManifestCommon {
  app: '39Note';
  paperSyncProtocolVersion: typeof PAPER_SYNC_PROTOCOL_VERSION;
  payloadStorage: typeof PAPER_PAYLOAD_STORAGE;
  documentId: string;
  paperFolderId: string;
  dataFolderId: string;
  displayName: string;
  /** True when the document entity is tombstoned in this generation. */
  deleted: boolean;
  writer: PaperWriterMetadata;
  state: CloudPayloadReference;
  productivity: CloudPayloadReference;
  /** Content-addressed conflict bodies, fetched only for a selected paper. */
  conflictJournal: CloudPayloadReference;
  /** Lightweight identities used to verify parent evidence during discovery. */
  conflictIds: string[];
  renderedPrintPdf?: RenderedPrintPdfDescriptor;
  recoveryEvidence?: CloudManifestRecoveryEvidence[];
  generation: PaperManifestGeneration;
}

/** Immutable historical layout. New code reads it but never republishes it. */
export interface PaperCloudManifestV2 extends PaperCloudManifestCommon {
  syncLayoutVersion: typeof LEGACY_PAPER_PACKAGE_LAYOUT_VERSION;
  manifestStorage: typeof LEGACY_PAPER_MANIFEST_STORAGE;
  sourcePdf?: SyncPdfDescriptor & { fileId: string };
  sourceArtifact?: never;
}

/** Current immutable layout with an honestly typed source artifact. */
export interface PaperCloudManifestV3 extends PaperCloudManifestCommon {
  syncLayoutVersion: typeof PAPER_PACKAGE_LAYOUT_VERSION;
  manifestStorage: typeof PAPER_MANIFEST_STORAGE;
  sourceArtifact?: SyncSourceArtifactDescriptor & {
    fileId: string;
    driveRole: 'paper-source-pdf' | 'paper-source-document';
  };
  sourcePdf?: never;
}

export type PaperCloudManifest = PaperCloudManifestV2 | PaperCloudManifestV3;

export interface PaperCloudSummary {
  documentId: string;
  displayName: string;
  deleted: boolean;
  paperFolderId: string;
  dataFolderId?: string;
  headIds: string[];
  headSetId: string;
  /** Non-authoritative invalidation index for removed Drive change entries. */
  managedFileIds?: string[];
  /** Drive-confirmed immutable manifest modification time, for display only. */
  publishedAt?: number;
  writerLabel?: string;
  sourcePdf?: SyncPdfDescriptor & { fileId: string };
  /** Normalized in-memory source identity for both package layouts. */
  sourceArtifact?: SyncSourceArtifactDescriptor & {
    fileId: string;
    driveRole: 'paper-source-pdf' | 'paper-source-document';
  };
  renderedPrintPdf?: RenderedPrintPdfDescriptor;
  localAvailability: PaperAvailability;
  status: PaperSyncStatus;
  presenceState?: 'present' | 'removed';
  presenceHeadIds?: string[];
  cleanupPending?: boolean;
  issue?: { code: string; message: string };
}

export interface PaperPackageSnapshot {
  documentId: string;
  displayName: string;
  snapshot: SyncSnapshot;
}

export interface LocalPaperPackage extends PaperPackageSnapshot {
  sourceArtifact?: LocalSyncSourceArtifact;
  /** The immutable Blob hash was already verified by the local adapter. */
  sourceArtifactHashVerified?: boolean;
  /** @deprecated Layout-2/local compatibility only. */
  sourcePdf?: LocalSyncPdf;
  /** The immutable Blob hash was already verified by the local adapter. */
  sourcePdfHashVerified?: boolean;
  /** Secondary, derived artifact. It never substitutes for sourceArtifact. */
  renderedPrintPdf?: StoredRenderedPrintPdf;
  renderedPrintPdfHashVerified?: boolean;
  writer: PaperWriterMetadata;
  deleted: boolean;
}

export interface PaperDownloadResult extends PaperPackageSnapshot {
  sourceArtifact?: StoredDocumentSource;
  reusedSourceArtifactFingerprint?: PdfFingerprintCacheEntry;
  sourceArtifactDriveEvidence?: PaperDriveFileEvidence;
  /** @deprecated PDF compatibility for callers not yet migrated to generic APIs. */
  sourcePdf?: StoredPdfFile;
  /** Allows the local adapter to reuse an unchanged stored PDF without rehashing it. */
  reusedSourcePdfFingerprint?: PdfFingerprintCacheEntry;
  sourcePdfDriveEvidence?: PaperDriveFileEvidence;
  renderedPrintPdf?: StoredRenderedPrintPdf;
  headIds: string[];
  conflicts: SyncConflict[];
  cloud: PaperCloudSummary;
}

export interface PaperPublishResult extends PaperPackageSnapshot {
  cloud: PaperCloudSummary;
  manifest: PaperCloudManifest;
  sourcePdfUploaded: boolean;
  sourcePdfDriveEvidence?: PaperDriveFileEvidence;
  sourceArtifactUploaded?: boolean;
  sourceArtifactDriveEvidence?: PaperDriveFileEvidence;
  renderedPrintPdfUploaded?: boolean;
  filesUploaded: number;
  remoteChanged: boolean;
  noOp: boolean;
  conflicts: SyncConflict[];
}

export type PaperRestoreMode = 'fast-untrash' | 'fallback-rebuild';

export interface PaperRestoreResult extends PaperPublishResult {
  restoreMode: PaperRestoreMode;
}

export interface PaperTransferProgress {
  documentId: string;
  phase:
    | 'discovering'
    | 'resolving'
    | 'downloading'
    | 'merging'
    | 'uploading'
    | 'publishing'
    | 'verifying';
  completed?: number;
  total?: number;
  bytesCompleted?: number;
  bytesTotal?: number;
  detail?: string;
}

export type PaperLayoutState =
  | 'paper-v3'
  | 'paper-v2-upgrade-required'
  | 'empty'
  | 'legacy-upgrade-required'
  | 'migration-incomplete'
  | 'unsupported-layout';

export interface PaperLayoutInspection {
  rootFolderId: string;
  state: PaperLayoutState;
  legacyManagedFileIds: string[];
  paperManagedFileIds: string[];
  controlManagedFileIds: string[];
  unknownFileIds: string[];
  detectedLayoutVersion?: number;
}
