import type { StoredPdfFile } from '../services/annotationPersistence.ts';
import type {
  DocumentSourceDescriptor,
  StoredDocumentSource,
} from '../types/document.ts';
import type { CloudSyncManifest } from './cloudFormat.ts';

export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_DATABASE_NAME = '39note-sync';
export const SYNC_DATABASE_VERSION = 2;
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export type SyncEntityKind =
  | 'document'
  | 'annotation'
  | 'note-anchor'
  | 'note'
  | 'glossary'
  | 'collection'
  | 'tag'
  | 'reading-position'
  | 'print-draft'
  | 'ai-conversation'
  | 'prompt-profile'
  | 'ai-configuration'
  | 'default-prompt';

export interface SyncEntityVersion {
  updatedAt: number;
  deviceId: string;
  hash: string;
}

export interface SyncEntityRecord {
  key: string;
  kind: SyncEntityKind;
  id: string;
  documentId?: string;
  value: unknown;
  version: SyncEntityVersion;
}

export interface SyncTombstone {
  key: string;
  kind: SyncEntityKind;
  id: string;
  documentId?: string;
  deletedAt: number;
  deviceId: string;
}

export interface SyncPdfDescriptor {
  documentId: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
  storedAt: number;
  sha256: string;
  fileId?: string;
}

export interface LocalSyncPdf extends SyncPdfDescriptor {
  blob: Blob;
}

/**
 * Format-independent source identity used by Paper package layout 3.
 *
 * `driveRole` is serialized only when a manifest pins an exact immutable Drive
 * artifact. Layout-3 keeps the accepted `paper-source-pdf` role for an honestly
 * typed PDF, while PPTX and DOCX use `paper-source-document`. In both cases the
 * manifest exposes the same generic `sourceArtifact` field.
 */
export interface SyncSourceArtifactDescriptor extends DocumentSourceDescriptor {
  lastModified: number;
  storedAt: number;
  fileId?: string;
  driveRole?: 'paper-source-pdf' | 'paper-source-document';
}

export interface LocalSyncSourceArtifact extends SyncSourceArtifactDescriptor {
  blob: Blob;
}

export type DownloadedSyncSourceArtifact = StoredDocumentSource;

export interface SyncSnapshot {
  app: '39Note';
  syncSchemaVersion: typeof SYNC_SCHEMA_VERSION;
  generatedAt: number;
  generatedBy: string;
  entities: SyncEntityRecord[];
  tombstones: SyncTombstone[];
  pdfs: SyncPdfDescriptor[];
}

export interface LocalSyncSnapshot extends Omit<SyncSnapshot, 'pdfs'> {
  pdfs: LocalSyncPdf[];
}

export interface SyncConflict {
  id: string;
  entityKey: string;
  entityKind: SyncEntityKind;
  documentId?: string;
  detectedAt: number;
  winningVersion: SyncEntityVersion;
  alternateVersion: SyncEntityVersion;
  winningValue: unknown;
  alternateValue: unknown;
  dismissedAt?: number;
}

export interface PdfFingerprintCacheEntry {
  size: number;
  lastModified: number;
  storedAt: number;
  sha256: string;
}

export type SourceArtifactFingerprintCacheEntry = PdfFingerprintCacheEntry;

export interface DriveFileCache {
  rootFolderId?: string;
  manifestFileId?: string;
  readmeFileId?: string;
  documentsFolderId?: string;
  fileIds: Record<string, string>;
}

export interface SyncDeviceState {
  id: 'device';
  deviceId: string;
  googleDeviceSessionToken?: string;
  autoSync: boolean;
  autoSyncBeforeReset?: boolean;
  resetIncomplete?: boolean;
  dirty: boolean;
  dirtyGeneration: number;
  lastAttemptedAt?: number;
  lastSuccessfulAt?: number;
  entityVersions: Record<string, SyncEntityVersion>;
  baselineHashes: Record<string, string>;
  tombstones: SyncTombstone[];
  conflicts: SyncConflict[];
  pdfFingerprints: Record<string, PdfFingerprintCacheEntry>;
  driveFiles: DriveFileCache;
  remoteManifestVersion?: string;
  remoteManifest?: CloudSyncManifest;
  remoteSnapshot?: SyncSnapshot;
}

export interface SyncApplyResult {
  changedDocumentIds: string[];
  deletedDocumentIds: string[];
}

export interface SyncProgress {
  phase:
    | 'idle'
    | 'connecting'
    | 'resetting'
    | 'discovering'
    | 'verifying'
    | 'pulling'
    | 'merging'
    | 'downloading'
    | 'uploading'
    | 'publishing'
    | 'finalizing';
  completed?: number;
  total?: number;
  bytesCompleted?: number;
  bytesTotal?: number;
  detail?: string;
}

export type SyncIntegrityLogicalType =
  'library-metadata' | 'ai-settings' | 'document-state' | 'productivity-data';

export interface SyncIntegrityIssue {
  logicalType: SyncIntegrityLogicalType;
  logicalPath: string;
  documentId?: string;
  documentTitle?: string;
  fileIdFingerprint: string;
  driveFileVersion?: string;
  /** Whether evidence is sufficient for a create-only immutable recovery publication. */
  immutableManifestRecoveryAvailable: boolean;
  expectedHashPrefix: string;
  actualHashPrefix: string;
  decodedHashPrefix?: string;
  byteLength: number;
  decodedByteLength?: number;
  actualPayloadValid: boolean;
  mismatchStage: 'immediately-after-download';
  verificationState: 'mismatch' | 'verified';
  retryOutcome: 'not-retried' | 'recovered' | 'persistent' | 'changed-during-retry';
  evidenceStable: boolean;
  validAlternateGenerationAvailable: boolean;
  localPayloadSemanticallyValid: boolean;
  remotePayloadSemanticallyValid: boolean;
  recommendedRecoveryChoices: Array<
    | 'repair-from-local'
    | 'preserve-and-merge-remote'
    | 'continue-sync'
    | 'manual-inspection'
  >;
  localRepairAvailable: boolean;
  remoteMergeAvailable: boolean;
}

export interface SyncSummary {
  localDocuments: number;
  cloudDocuments: number;
  mergedDocuments: number;
  pdfsDownloaded: number;
  pdfsUploaded: number;
  filesUpdated: number;
  conflictsPreserved: number;
}

export interface SyncRemotePullResult {
  snapshot: SyncSnapshot;
  manifestVersion?: string;
  rootFolderId: string;
  usedCachedSnapshot: boolean;
  requiresPublicationUpgrade?: boolean;
  /** Conflicts found while deterministically combining concurrent cloud heads. */
  conflicts?: SyncConflict[];
}

export interface SyncRemotePushResult {
  snapshot: SyncSnapshot;
  manifestVersion: string;
  pdfsUploaded: number;
  filesUpdated: number;
}

export interface SyncRemoteResetResult extends SyncRemotePushResult {
  filesTrashed: number;
}

export interface SyncLocalAdapter {
  createSnapshot(state: SyncDeviceState): Promise<LocalSyncSnapshot>;
  applySnapshot(
    snapshot: SyncSnapshot,
    downloadedPdfs: ReadonlyMap<string, StoredPdfFile>,
    signal?: AbortSignal,
  ): Promise<SyncApplyResult>;
}

export interface SyncRemoteRepository {
  pull(state: SyncDeviceState, signal: AbortSignal): Promise<SyncRemotePullResult>;
  downloadPdf(pdf: SyncPdfDescriptor, signal: AbortSignal): Promise<StoredPdfFile>;
  push(
    snapshot: SyncSnapshot,
    localPdfs: readonly LocalSyncPdf[],
    state: SyncDeviceState,
    signal: AbortSignal,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncRemotePushResult>;
  getRootFolderUrl(): string | null;
}

export function createSyncEntityKey(
  kind: SyncEntityKind,
  id: string,
  documentId?: string,
): string {
  return `${kind}:${encodeURIComponent(documentId ?? '')}:${encodeURIComponent(id)}`;
}
