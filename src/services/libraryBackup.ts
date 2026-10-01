import type JSZipType from 'jszip';
import {
  getBackupDocumentDataStrict,
  listLibraryDocuments,
  listCollections,
  listTags,
  restoreLibraryEntities,
  restoreBackupDocument,
  validateBackupDocumentState,
  type PersistedDocumentState,
  type StoredPdfFile,
} from './annotationPersistence';
import {
  DOCUMENT_FILE_EXTENSIONS,
  DOCUMENT_MIME_TYPES,
  hasDocumentFileExtension,
  isDocumentMimeType,
  isDocumentType,
  type DocumentMimeType,
  type DocumentType,
  type StoredDocumentSource,
} from '../types/document.ts';
import type { CollectionRecord, TagRecord } from '../types/library';
import {
  getArchiveEntryKey,
  isSafeLegacyDocumentIdForArchive,
  isValidDocumentId,
} from '../utils/documentId';
import {
  getProductivityBackupDataStrict,
  loadRenderedPrintPdf,
  restoreRenderedPrintPdf,
  restoreProductivityBackupData,
  sanitizeProductivityBackupData,
  type ProductivityBackupDocument,
} from './productivityPersistence';
import { validateStoredRenderedPrintPdf } from '../print/renderedPrintPdf.ts';
import type { StoredRenderedPrintPdf } from '../types/productivity.ts';
import type { PaperCloudSummary } from '../sync/paperTypes.ts';
import { loadCloudPaperCatalog, loadPaperSyncDeviceProfile } from '../sync/storage.ts';
import { validateStoredDocumentSource } from './documentSourceValidation.ts';
import { isSha256, sha256Hex } from '../sync/hash.ts';

export const BACKUP_FORMAT_VERSION = 5;
const PAPER_COVERAGE_BACKUP_FORMAT_VERSION = 4;
const PRODUCTIVITY_BACKUP_FORMAT_VERSION = 3;
const ARCHIVE_KEY_BACKUP_FORMAT_VERSION = 2;
const LEGACY_BACKUP_FORMAT_VERSION = 1;
const BACKUP_ROOT = '39note-backup/';

export interface BackupCloudOnlyPaper {
  documentId: string;
  displayName: string;
}

export interface BackupPaperCoverage {
  /** Papers whose editable state is actually present in this ZIP. */
  locallyAvailableCount: number;
  /** Null means the locally cached Drive catalog was not authoritative enough to count. */
  cloudOnlyCount: number | null;
  /** Cloud-only bytes are never fetched merely to create a local backup. */
  cloudOnlyContentIncluded: false;
  cloudCatalog:
    | { status: 'cached-snapshot'; scannedAt: number }
    | { status: 'unavailable' }
    | { status: 'not-applicable' };
  /** Metadata only. No PDF, editable payload, or Drive content is included for these papers. */
  cloudOnlyPapers: BackupCloudOnlyPaper[];
}

export interface BackupManifestDocument {
  documentId: string;
  hasStoredSource?: boolean;
  sourceArtifact?: BackupSourceArtifact;
  /** Legacy v1-v4 PDF-only metadata. */
  hasStoredPdf?: boolean;
  recordEntry?: string;
  pdfEntry?: string;
  productivityEntry?: string;
  renderedPrintPdf?: BackupRenderedPrintPdf;
}

export interface BackupRenderedPrintPdf {
  kind: 'rendered-print-pdf';
  documentId: string;
  fileName: string;
  mimeType: 'application/pdf';
  size: number;
  sha256: string;
  renderedFromDraftHash: string;
  createdAt: number;
  storedAt: number;
  artifactEntry: string;
}

export interface BackupSourceArtifact {
  documentId: string;
  documentType: DocumentType;
  mimeType: DocumentMimeType;
  originalFileName: string;
  sha256: string;
  size: number;
  sourceEntry: string;
}

export interface BackupManifest {
  backupFormatVersion: number;
  application: '39Note';
  createdAt: number;
  documentCount: number;
  annotationCount: number;
  noteCount: number;
  documents: BackupManifestDocument[];
  backupScope?: 'library' | 'selected';
  selectedDocumentCount?: number;
  printDraftCount?: number;
  aiConversationCount?: number;
  renderedPrintPdfCount?: number;
  paperCoverage?: BackupPaperCoverage;
}

export interface RestorePreview {
  manifest: BackupManifest;
  documents: Array<{
    state: PersistedDocumentState;
    source: StoredDocumentSource | null;
    /** @deprecated PDF compatibility alias. */
    pdf: StoredPdfFile | null;
    renderedPrintPdf: StoredRenderedPrintPdf | null;
  }>;
  conflictCount: number;
  sourceCount: number;
  pdfCount: number;
  highlightCount: number;
  underlineCount: number;
  noteCount: number;
  collections: CollectionRecord[];
  tags: TagRecord[];
  productivity: ProductivityBackupDocument[];
  renderedPrintPdfCount: number;
}

export async function downloadLibraryBackup(
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  const documents = await getBackupDocumentDataStrict();
  const [collections, tags, paperCoverage] = await Promise.all([
    listCollections(),
    listTags(),
    loadCachedLibraryPaperCoverage(documents.map(({ state }) => state.documentId)),
  ]);
  await downloadBackupArchive(
    documents,
    collections,
    tags,
    'library',
    paperCoverage,
    onProgress,
  );
}

export async function downloadSelectedPackage(
  documentIds: readonly string[],
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  const uniqueIds = [...new Set(documentIds)];
  const documents = await getBackupDocumentDataStrict(uniqueIds);
  if (documents.length !== uniqueIds.length) {
    throw new Error('One or more selected documents could not be packaged.');
  }
  const referencedCollectionIds = new Set(
    documents.flatMap(({ state }) => state.collectionIds),
  );
  const referencedTagIds = new Set(documents.flatMap(({ state }) => state.tagIds));
  const [allCollections, allTags] = await Promise.all([listCollections(), listTags()]);
  await downloadBackupArchive(
    documents,
    allCollections.filter((collection) => referencedCollectionIds.has(collection.id)),
    allTags.filter((tag) => referencedTagIds.has(tag.id)),
    'selected',
    createBackupPaperCoverage(
      documents.map(({ state }) => state.documentId),
      null,
      undefined,
      'selected',
    ),
    onProgress,
  );
}

/**
 * Describes what a local ZIP really contains. The optional Drive catalog is a
 * previously completed local metadata scan; creating a backup never downloads
 * cloud paper bytes.
 */
export function createBackupPaperCoverage(
  localDocumentIds: readonly string[],
  cloudCatalog: readonly Pick<PaperCloudSummary, 'documentId' | 'displayName'>[] | null,
  scannedAt?: number,
  scope: 'library' | 'selected' = 'library',
): BackupPaperCoverage {
  const localIds = new Set(localDocumentIds);
  if (scope === 'selected') {
    return {
      locallyAvailableCount: localIds.size,
      cloudOnlyCount: null,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'not-applicable' },
      cloudOnlyPapers: [],
    };
  }

  if (
    !cloudCatalog ||
    typeof scannedAt !== 'number' ||
    !Number.isFinite(scannedAt) ||
    scannedAt < 0 ||
    cloudCatalog.some(
      (paper) =>
        !isValidDocumentId(paper.documentId) ||
        typeof paper.displayName !== 'string' ||
        paper.displayName.trim().length === 0,
    )
  ) {
    return {
      locallyAvailableCount: localIds.size,
      cloudOnlyCount: null,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'unavailable' },
      cloudOnlyPapers: [],
    };
  }

  const cloudOnlyById = new Map<string, BackupCloudOnlyPaper>();
  for (const paper of cloudCatalog) {
    if (!localIds.has(paper.documentId)) {
      cloudOnlyById.set(paper.documentId, {
        documentId: paper.documentId,
        displayName: paper.displayName,
      });
    }
  }
  const cloudOnlyPapers = [...cloudOnlyById.values()].sort((left, right) =>
    left.documentId.localeCompare(right.documentId),
  );
  return {
    locallyAvailableCount: localIds.size,
    cloudOnlyCount: cloudOnlyPapers.length,
    cloudOnlyContentIncluded: false,
    cloudCatalog: { status: 'cached-snapshot', scannedAt },
    cloudOnlyPapers,
  };
}

async function loadCachedLibraryPaperCoverage(
  localDocumentIds: readonly string[],
): Promise<BackupPaperCoverage> {
  try {
    const [profile, papers] = await Promise.all([
      loadPaperSyncDeviceProfile(),
      loadCloudPaperCatalog(),
    ]);
    if (!profile.rootFolderId) {
      return createBackupPaperCoverage(localDocumentIds, null);
    }
    return createBackupPaperCoverage(localDocumentIds, papers, profile.lastDiscoveryAt);
  } catch {
    return createBackupPaperCoverage(localDocumentIds, null);
  }
}

async function downloadBackupArchive(
  documents: Awaited<ReturnType<typeof getBackupDocumentDataStrict>>,
  collections: CollectionRecord[],
  tags: TagRecord[],
  scope: 'library' | 'selected',
  paperCoverage: BackupPaperCoverage,
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  const documentIds = documents.map(({ state }) => state.documentId);
  const [productivity, renderedPrintPdfs] = await Promise.all([
    getProductivityBackupDataStrict(documentIds),
    Promise.all(documentIds.map((documentId) => loadRenderedPrintPdf(documentId))),
  ]);
  const productivityByDocument = new Map(
    productivity.map((record) => [record.documentId, record] as const),
  );
  const manifest: BackupManifest = {
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    application: '39Note',
    createdAt: Date.now(),
    documentCount: documents.length,
    annotationCount: documents.reduce(
      (count, document) =>
        count +
        document.state.annotations.length +
        document.state.officeAnnotations.length,
      0,
    ),
    noteCount: documents.reduce(
      (count, document) => count + document.state.notes.length,
      0,
    ),
    documents: documents.map(({ state, source }, index) => {
      return createBackupManifestDocument(
        state.documentId,
        source,
        renderedPrintPdfs[index],
      );
    }),
    backupScope: scope,
    printDraftCount: productivity.filter((record) => record.printDraft).length,
    aiConversationCount: productivity.reduce(
      (count, record) => count + record.aiConversations.length,
      0,
    ),
    renderedPrintPdfCount: renderedPrintPdfs.filter(Boolean).length,
    paperCoverage,
    ...(scope === 'selected' ? { selectedDocumentCount: documents.length } : {}),
  };

  zip.file(`${BACKUP_ROOT}manifest.json`, JSON.stringify(manifest));
  zip.file(`${BACKUP_ROOT}collections.json`, JSON.stringify(collections));
  zip.file(`${BACKUP_ROOT}tags.json`, JSON.stringify(tags));
  for (const [index, document] of documents.entries()) {
    const manifestDocument = manifest.documents[index];
    zip.file(
      `${BACKUP_ROOT}${manifestDocument.recordEntry}`,
      JSON.stringify(document.state),
    );
    if (document.source && manifestDocument.sourceArtifact) {
      zip.file(
        `${BACKUP_ROOT}${manifestDocument.sourceArtifact.sourceEntry}`,
        document.source.blob,
      );
    }
    if (renderedPrintPdfs[index] && manifestDocument.renderedPrintPdf) {
      zip.file(
        `${BACKUP_ROOT}${manifestDocument.renderedPrintPdf.artifactEntry}`,
        renderedPrintPdfs[index]!.blob,
      );
    }
    const productivityRecord = productivityByDocument.get(document.state.documentId);
    if (!manifestDocument.productivityEntry || !productivityRecord) {
      throw new Error('A paper productivity record could not be backed up safely.');
    }
    zip.file(
      `${BACKUP_ROOT}${manifestDocument.productivityEntry}`,
      JSON.stringify(productivityRecord),
    );
    onProgress(index + 1, documents.length);
    await yieldToBrowser();
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const prefix =
    scope === 'selected'
      ? `39Note-package-${documents.length}-document${documents.length === 1 ? '' : 's'}`
      : '39Note-backup';
  downloadBlob(blob, `${prefix}-${formatBackupTimestamp(manifest.createdAt)}.zip`);
}

export async function inspectBackup(file: File): Promise<RestorePreview> {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(file);
  const entries = Object.keys(zip.files);
  assertSafeZipEntries(zip, entries);

  const manifestFile = zip.file(`${BACKUP_ROOT}manifest.json`);
  if (!manifestFile) {
    throw new Error('This is not a 39Note backup.');
  }

  const manifest = parseBackupManifest(JSON.parse(await manifestFile.async('text')));
  const expectedEntries = getExpectedEntries(manifest);
  expectedEntries.add(`${BACKUP_ROOT}collections.json`);
  expectedEntries.add(`${BACKUP_ROOT}tags.json`);
  if (entries.some((name) => !expectedEntries.has(name))) {
    throw new Error('A backup archive entry is unexpected or unsafe.');
  }

  const documents = await Promise.all(
    manifest.documents.map(async (manifestDocument, index) => {
      const recordEntry = getRecordEntry(manifest, manifestDocument);
      const stateFile = zip.file(`${BACKUP_ROOT}${recordEntry}`);
      if (!stateFile) {
        throw new Error(`Backup document ${index + 1} is missing its record.`);
      }

      const state = validateBackupDocumentState(
        JSON.parse(await stateFile.async('text')),
      );
      if (!state) {
        throw new Error(`Backup document ${index + 1} has an invalid record.`);
      }
      if (state.documentId !== manifestDocument.documentId) {
        throw new Error(
          `Backup document ${index + 1} does not match the identifier in the manifest.`,
        );
      }

      const sourceEntry = getSourceEntry(manifest, manifestDocument);
      const sourceFile = sourceEntry ? zip.file(`${BACKUP_ROOT}${sourceEntry}`) : null;
      const expectsSource =
        manifest.backupFormatVersion >= BACKUP_FORMAT_VERSION
          ? manifestDocument.hasStoredSource === true
          : manifestDocument.hasStoredPdf === true;
      if (expectsSource !== Boolean(sourceFile)) {
        throw new Error(
          `Backup document ${index + 1} has inconsistent source metadata.`,
        );
      }

      const source = sourceFile
        ? manifest.backupFormatVersion >= BACKUP_FORMAT_VERSION
          ? await createStoredSource(
              state,
              manifestDocument.sourceArtifact!,
              await sourceFile.async('uint8array'),
            )
          : await createLegacyStoredPdf(state, await sourceFile.async('uint8array'))
        : null;
      const pdf: StoredPdfFile | null =
        source?.documentType === 'pdf' ? { ...source, documentType: 'pdf' } : null;
      const productivityEntry = getProductivityEntry(manifest, manifestDocument);
      const productivityFile = productivityEntry
        ? zip.file(`${BACKUP_ROOT}${productivityEntry}`)
        : null;
      if (Boolean(productivityEntry) !== Boolean(productivityFile)) {
        throw new Error(
          `Backup document ${index + 1} has inconsistent productivity data.`,
        );
      }
      const productivity = productivityFile
        ? sanitizeProductivityBackupData(
            JSON.parse(await productivityFile.async('text')),
            state.documentId,
          )
        : null;
      if (productivityFile && !productivity) {
        throw new Error(`Backup document ${index + 1} has invalid productivity data.`);
      }
      const renderedPrintPdfEntry = manifestDocument.renderedPrintPdf?.artifactEntry;
      const renderedPrintPdfFile = renderedPrintPdfEntry
        ? zip.file(`${BACKUP_ROOT}${renderedPrintPdfEntry}`)
        : null;
      if (Boolean(renderedPrintPdfEntry) !== Boolean(renderedPrintPdfFile)) {
        throw new Error(
          `Backup document ${index + 1} has inconsistent Print PDF data.`,
        );
      }
      let renderedPrintPdf: StoredRenderedPrintPdf | null = null;
      if (renderedPrintPdfFile && manifestDocument.renderedPrintPdf) {
        const bytes = await renderedPrintPdfFile.async('uint8array');
        const copied = new Uint8Array(bytes.byteLength);
        copied.set(bytes);
        renderedPrintPdf = await validateStoredRenderedPrintPdf(
          {
            ...manifestDocument.renderedPrintPdf,
            blob: new Blob([copied], { type: 'application/pdf' }),
          },
          state.documentId,
        );
        if (!renderedPrintPdf) {
          throw new Error(`Backup document ${index + 1} has an invalid Print PDF.`);
        }
      }
      return { state, source, pdf, productivity, renderedPrintPdf };
    }),
  );
  const collections = await readEntities<CollectionRecord>(zip, 'collections.json');
  const tags = await readEntities<TagRecord>(zip, 'tags.json');

  const existingIds = new Set(
    (await listLibraryDocuments()).map((document) => document.documentId),
  );
  return {
    manifest,
    documents,
    conflictCount: documents.filter(({ state }) => existingIds.has(state.documentId))
      .length,
    sourceCount: documents.filter(({ source }) => source).length,
    pdfCount: documents.filter(({ pdf }) => pdf).length,
    highlightCount: documents.reduce(
      (count, { state }) =>
        count +
        state.annotations.filter((annotation) => annotation.type === 'highlight')
          .length +
        state.officeAnnotations.filter(
          (annotation) => annotation.markType === 'highlight',
        ).length,
      0,
    ),
    underlineCount: documents.reduce(
      (count, { state }) =>
        count +
        state.annotations.filter((annotation) => annotation.type === 'underline')
          .length +
        state.officeAnnotations.filter(
          (annotation) => annotation.markType === 'underline',
        ).length,
      0,
    ),
    noteCount: documents.reduce((count, { state }) => count + state.notes.length, 0),
    collections,
    tags,
    productivity: documents.flatMap((document) =>
      document.productivity ? [document.productivity] : [],
    ),
    renderedPrintPdfCount: documents.filter(({ renderedPrintPdf }) => renderedPrintPdf)
      .length,
  };
}

export async function restoreBackup(
  preview: RestorePreview,
  replaceExisting: boolean,
): Promise<{ imported: number; failed: number }> {
  const existingIds = new Set(
    (await listLibraryDocuments()).map((document) => document.documentId),
  );
  let imported = 0;
  let failed = 0;
  const restoredDocumentIds = new Set<string>();
  for (const document of preview.documents) {
    if (existingIds.has(document.state.documentId) && !replaceExisting) continue;
    if (await restoreBackupDocument(document.state, document.source, replaceExisting)) {
      await restoreRenderedPrintPdf(
        document.state.documentId,
        document.renderedPrintPdf,
        false,
      );
      imported += 1;
      restoredDocumentIds.add(document.state.documentId);
    } else failed += 1;
  }
  await restoreProductivityBackupData(
    preview.productivity.filter((record) => restoredDocumentIds.has(record.documentId)),
  );
  await restoreLibraryEntities(preview.collections, preview.tags);
  return { imported, failed };
}

async function readEntities<T>(zip: JSZipType, entryName: string): Promise<T[]> {
  const entry = zip.file(`${BACKUP_ROOT}${entryName}`);
  if (!entry) return [];
  const value = JSON.parse(await entry.async('text'));
  return Array.isArray(value) ? (value as T[]) : [];
}

export function createBackupManifestDocument(
  documentId: string,
  source: StoredDocumentSource | null | false,
  renderedPrintPdf: StoredRenderedPrintPdf | null = null,
): BackupManifestDocument {
  if (!isValidDocumentId(documentId)) {
    throw new Error(
      'A Library document has an invalid identifier and cannot be backed up.',
    );
  }

  const archiveKey = getArchiveEntryKey(documentId);
  const storedSource = source || null;
  if (storedSource && storedSource.documentId !== documentId) {
    throw new Error('A source artifact does not match its Library document.');
  }
  if (renderedPrintPdf && renderedPrintPdf.documentId !== documentId) {
    throw new Error('A rendered Print PDF does not match its Library document.');
  }
  return {
    documentId,
    hasStoredSource: Boolean(storedSource),
    recordEntry: `documents/${archiveKey}.json`,
    ...(storedSource
      ? {
          sourceArtifact: {
            documentId,
            documentType: storedSource.documentType,
            mimeType: storedSource.mimeType,
            originalFileName: storedSource.fileName,
            sha256: storedSource.sha256,
            size: storedSource.size,
            sourceEntry: `sources/${archiveKey}${DOCUMENT_FILE_EXTENSIONS[storedSource.documentType]}`,
          },
        }
      : {}),
    productivityEntry: `productivity/${archiveKey}.json`,
    ...(renderedPrintPdf
      ? {
          renderedPrintPdf: {
            kind: 'rendered-print-pdf' as const,
            documentId,
            fileName: renderedPrintPdf.fileName,
            mimeType: 'application/pdf' as const,
            size: renderedPrintPdf.size,
            sha256: renderedPrintPdf.sha256,
            renderedFromDraftHash: renderedPrintPdf.renderedFromDraftHash,
            createdAt: renderedPrintPdf.createdAt,
            storedAt: renderedPrintPdf.storedAt,
            artifactEntry: `rendered-print-pdfs/${archiveKey}.pdf`,
          },
        }
      : {}),
  };
}

export function parseBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)) {
    throw new Error('Backup manifest is invalid.');
  }
  if (
    typeof value.backupFormatVersion !== 'number' ||
    !isSupportedBackupFormatVersion(value.backupFormatVersion) ||
    value.application !== '39Note' ||
    !Array.isArray(value.documents)
  ) {
    throw new Error('This backup format is not supported.');
  }
  if (
    typeof value.createdAt !== 'number' ||
    typeof value.documentCount !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    !Number.isInteger(value.documentCount) ||
    value.documentCount !== value.documents.length
  ) {
    throw new Error('Backup manifest counts are invalid.');
  }

  const backupFormatVersion = value.backupFormatVersion as number;
  const createdAt = value.createdAt as number;
  const documentCount = value.documentCount as number;
  const documents = value.documents.map((document, index) =>
    parseManifestDocument(document, index, backupFormatVersion),
  );
  if (
    new Set(documents.map((document) => document.documentId)).size !== documents.length
  ) {
    throw new Error('Backup manifest contains duplicate document identifiers.');
  }
  if (
    value.backupScope === 'selected' &&
    (!Number.isInteger(value.selectedDocumentCount) ||
      value.selectedDocumentCount !== documentCount)
  ) {
    throw new Error('Selective package manifest counts are invalid.');
  }
  const renderedPrintPdfCount = documents.filter(
    (document) => document.renderedPrintPdf,
  ).length;
  if (
    backupFormatVersion === BACKUP_FORMAT_VERSION &&
    (value.renderedPrintPdfCount !== undefined
      ? !Number.isInteger(value.renderedPrintPdfCount) ||
        (value.renderedPrintPdfCount as number) < 0 ||
        value.renderedPrintPdfCount !== renderedPrintPdfCount
      : renderedPrintPdfCount !== 0)
  ) {
    throw new Error('Backup Print PDF counts are invalid.');
  }
  if (
    backupFormatVersion < BACKUP_FORMAT_VERSION &&
    value.renderedPrintPdfCount !== undefined
  ) {
    throw new Error('This backup version has unsupported Print PDF metadata.');
  }
  const paperCoverage =
    backupFormatVersion >= PAPER_COVERAGE_BACKUP_FORMAT_VERSION
      ? parsePaperCoverage(value.paperCoverage, documentCount, documents)
      : undefined;
  if (
    paperCoverage &&
    ((value.backupScope === 'selected' &&
      paperCoverage.cloudCatalog.status !== 'not-applicable') ||
      (value.backupScope !== 'selected' &&
        paperCoverage.cloudCatalog.status === 'not-applicable'))
  ) {
    throw new Error('Backup paper coverage does not match its scope.');
  }

  return {
    backupFormatVersion,
    application: '39Note',
    createdAt,
    documentCount,
    annotationCount:
      typeof value.annotationCount === 'number' ? value.annotationCount : 0,
    noteCount: typeof value.noteCount === 'number' ? value.noteCount : 0,
    documents,
    backupScope: value.backupScope === 'selected' ? 'selected' : 'library',
    ...(value.backupScope === 'selected' &&
    typeof value.selectedDocumentCount === 'number'
      ? { selectedDocumentCount: value.selectedDocumentCount }
      : {}),
    printDraftCount:
      typeof value.printDraftCount === 'number' ? value.printDraftCount : 0,
    aiConversationCount:
      typeof value.aiConversationCount === 'number' ? value.aiConversationCount : 0,
    ...(backupFormatVersion === BACKUP_FORMAT_VERSION ? { renderedPrintPdfCount } : {}),
    ...(paperCoverage ? { paperCoverage } : {}),
  };
}

function isSupportedBackupFormatVersion(value: number): boolean {
  return (
    value === LEGACY_BACKUP_FORMAT_VERSION ||
    value === ARCHIVE_KEY_BACKUP_FORMAT_VERSION ||
    value === PRODUCTIVITY_BACKUP_FORMAT_VERSION ||
    value === PAPER_COVERAGE_BACKUP_FORMAT_VERSION ||
    value === BACKUP_FORMAT_VERSION
  );
}

function parsePaperCoverage(
  value: unknown,
  documentCount: number,
  documents: readonly BackupManifestDocument[],
): BackupPaperCoverage {
  if (
    !isRecord(value) ||
    value.locallyAvailableCount !== documentCount ||
    value.cloudOnlyContentIncluded !== false ||
    !Array.isArray(value.cloudOnlyPapers) ||
    !isRecord(value.cloudCatalog)
  ) {
    throw new Error('Backup paper coverage is invalid.');
  }

  const localIds = new Set(documents.map((document) => document.documentId));
  const cloudOnlyPapers = value.cloudOnlyPapers.map((paper) => {
    if (
      !isRecord(paper) ||
      !isValidDocumentId(paper.documentId) ||
      typeof paper.displayName !== 'string' ||
      paper.displayName.trim().length === 0 ||
      localIds.has(paper.documentId)
    ) {
      throw new Error('Backup cloud-only paper metadata is invalid.');
    }
    return { documentId: paper.documentId, displayName: paper.displayName };
  });
  if (
    new Set(cloudOnlyPapers.map((paper) => paper.documentId)).size !==
    cloudOnlyPapers.length
  ) {
    throw new Error('Backup cloud-only paper metadata contains duplicate identifiers.');
  }

  const status = value.cloudCatalog.status;
  if (status === 'cached-snapshot') {
    if (
      typeof value.cloudCatalog.scannedAt !== 'number' ||
      !Number.isFinite(value.cloudCatalog.scannedAt) ||
      value.cloudCatalog.scannedAt < 0 ||
      !Number.isInteger(value.cloudOnlyCount) ||
      value.cloudOnlyCount !== cloudOnlyPapers.length
    ) {
      throw new Error('Backup cached cloud-paper coverage is invalid.');
    }
    return {
      locallyAvailableCount: documentCount,
      cloudOnlyCount: value.cloudOnlyCount,
      cloudOnlyContentIncluded: false,
      cloudCatalog: {
        status: 'cached-snapshot',
        scannedAt: value.cloudCatalog.scannedAt,
      },
      cloudOnlyPapers,
    };
  }

  if (
    (status !== 'unavailable' && status !== 'not-applicable') ||
    value.cloudOnlyCount !== null ||
    cloudOnlyPapers.length !== 0 ||
    value.cloudCatalog.scannedAt !== undefined
  ) {
    throw new Error('Backup cloud-paper coverage is invalid.');
  }
  return {
    locallyAvailableCount: documentCount,
    cloudOnlyCount: null,
    cloudOnlyContentIncluded: false,
    cloudCatalog: { status },
    cloudOnlyPapers: [],
  };
}

function parseManifestDocument(
  value: unknown,
  index: number,
  backupFormatVersion: number,
): BackupManifestDocument {
  if (!isRecord(value) || !isValidDocumentId(value.documentId)) {
    throw new Error(
      `Backup document ${index + 1} has a missing or invalid identifier.`,
    );
  }
  if (backupFormatVersion === BACKUP_FORMAT_VERSION) {
    if (
      typeof value.hasStoredSource !== 'boolean' ||
      value.hasStoredPdf !== undefined ||
      value.pdfEntry !== undefined
    ) {
      throw new Error(`Backup document ${index + 1} has invalid source metadata.`);
    }
    const expectedKey = getArchiveEntryKey(value.documentId);
    const expectedRecordEntry = `documents/${expectedKey}.json`;
    const expectedProductivityEntry = `productivity/${expectedKey}.json`;
    if (value.recordEntry !== expectedRecordEntry) {
      throw new Error(`Backup document ${index + 1} has an unsafe archive entry path.`);
    }
    if (value.productivityEntry !== expectedProductivityEntry) {
      throw new Error(
        `Backup document ${index + 1} is missing required productivity data.`,
      );
    }
    const sourceArtifact = value.hasStoredSource
      ? parseSourceArtifact(value.sourceArtifact, value.documentId, expectedKey, index)
      : undefined;
    if (!value.hasStoredSource && value.sourceArtifact !== undefined) {
      throw new Error(`Backup document ${index + 1} has inconsistent source metadata.`);
    }
    const renderedPrintPdf =
      value.renderedPrintPdf === undefined
        ? undefined
        : parseRenderedPrintPdf(
            value.renderedPrintPdf,
            value.documentId,
            expectedKey,
            index,
          );
    return {
      documentId: value.documentId,
      hasStoredSource: value.hasStoredSource,
      recordEntry: expectedRecordEntry,
      ...(sourceArtifact ? { sourceArtifact } : {}),
      productivityEntry: expectedProductivityEntry,
      ...(renderedPrintPdf ? { renderedPrintPdf } : {}),
    };
  }

  if (value.renderedPrintPdf !== undefined) {
    throw new Error(`Backup document ${index + 1} has unsupported Print PDF metadata.`);
  }

  if (typeof value.hasStoredPdf !== 'boolean') {
    throw new Error(`Backup document ${index + 1} has invalid PDF metadata.`);
  }

  if (backupFormatVersion === LEGACY_BACKUP_FORMAT_VERSION) {
    if (!isSafeLegacyDocumentIdForArchive(value.documentId)) {
      throw new Error(
        `Backup document ${index + 1} uses an unsupported legacy identifier format.`,
      );
    }
    return { documentId: value.documentId, hasStoredPdf: value.hasStoredPdf };
  }

  const expectedKey = getArchiveEntryKey(value.documentId);
  const expectedRecordEntry = `documents/${expectedKey}.json`;
  const expectedPdfEntry = `pdfs/${expectedKey}.pdf`;
  const expectedProductivityEntry = `productivity/${expectedKey}.json`;
  if (
    value.recordEntry !== expectedRecordEntry ||
    (value.hasStoredPdf && value.pdfEntry !== expectedPdfEntry)
  ) {
    throw new Error(`Backup document ${index + 1} has an unsafe archive entry path.`);
  }
  if (!value.hasStoredPdf && value.pdfEntry !== undefined) {
    throw new Error(`Backup document ${index + 1} has inconsistent PDF metadata.`);
  }
  if (
    backupFormatVersion >= PRODUCTIVITY_BACKUP_FORMAT_VERSION &&
    value.productivityEntry !== undefined &&
    value.productivityEntry !== expectedProductivityEntry
  ) {
    throw new Error(
      `Backup document ${index + 1} has an unsafe productivity entry path.`,
    );
  }
  if (
    backupFormatVersion < PRODUCTIVITY_BACKUP_FORMAT_VERSION &&
    value.productivityEntry !== undefined
  ) {
    throw new Error(
      `Backup document ${index + 1} has unsupported productivity metadata.`,
    );
  }
  if (
    backupFormatVersion === PAPER_COVERAGE_BACKUP_FORMAT_VERSION &&
    value.productivityEntry !== expectedProductivityEntry
  ) {
    throw new Error(
      `Backup document ${index + 1} is missing required productivity data.`,
    );
  }

  return {
    documentId: value.documentId,
    hasStoredPdf: value.hasStoredPdf,
    recordEntry: expectedRecordEntry,
    ...(value.hasStoredPdf ? { pdfEntry: expectedPdfEntry } : {}),
    ...(value.productivityEntry === expectedProductivityEntry
      ? { productivityEntry: expectedProductivityEntry }
      : {}),
  };
}

function parseSourceArtifact(
  value: unknown,
  documentId: string,
  archiveKey: string,
  index: number,
): BackupSourceArtifact {
  if (
    !isRecord(value) ||
    value.documentId !== documentId ||
    !isDocumentType(value.documentType) ||
    !isDocumentMimeType(value.mimeType) ||
    value.mimeType !== DOCUMENT_MIME_TYPES[value.documentType] ||
    typeof value.originalFileName !== 'string' ||
    !hasDocumentFileExtension(value.originalFileName, value.documentType) ||
    !isSha256(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0
  ) {
    throw new Error(`Backup document ${index + 1} has invalid source metadata.`);
  }
  const expectedSourceEntry = `sources/${archiveKey}${DOCUMENT_FILE_EXTENSIONS[value.documentType]}`;
  if (value.sourceEntry !== expectedSourceEntry) {
    throw new Error(`Backup document ${index + 1} has an unsafe source entry path.`);
  }
  return {
    documentId,
    documentType: value.documentType,
    mimeType: value.mimeType,
    originalFileName: value.originalFileName,
    sha256: value.sha256,
    size: value.size as number,
    sourceEntry: expectedSourceEntry,
  };
}

function parseRenderedPrintPdf(
  value: unknown,
  documentId: string,
  archiveKey: string,
  index: number,
): BackupRenderedPrintPdf {
  const expectedArtifactEntry = `rendered-print-pdfs/${archiveKey}.pdf`;
  if (
    !isRecord(value) ||
    value.kind !== 'rendered-print-pdf' ||
    value.documentId !== documentId ||
    !isSafeRenderedPrintPdfFileName(value.fileName) ||
    value.mimeType !== 'application/pdf' ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) <= 0 ||
    !isSha256(value.sha256) ||
    !isSha256(value.renderedFromDraftHash) ||
    !isNonNegativeTimestamp(value.createdAt) ||
    !isNonNegativeTimestamp(value.storedAt)
  ) {
    throw new Error(`Backup document ${index + 1} has invalid Print PDF metadata.`);
  }
  if (value.artifactEntry !== expectedArtifactEntry) {
    throw new Error(`Backup document ${index + 1} has an unsafe Print PDF entry path.`);
  }
  return {
    kind: 'rendered-print-pdf',
    documentId,
    fileName: value.fileName,
    mimeType: 'application/pdf',
    size: value.size as number,
    sha256: value.sha256,
    renderedFromDraftHash: value.renderedFromDraftHash,
    createdAt: value.createdAt,
    storedAt: value.storedAt,
    artifactEntry: expectedArtifactEntry,
  };
}

function isSafeRenderedPrintPdfFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value.endsWith(' - Print.pdf') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    ![...value].some((character) => character.charCodeAt(0) <= 0x1f)
  );
}

function isNonNegativeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function getExpectedEntries(manifest: BackupManifest): Set<string> {
  const expectedEntries = new Set<string>([
    BACKUP_ROOT,
    `${BACKUP_ROOT}documents/`,
    `${BACKUP_ROOT}manifest.json`,
  ]);
  for (const document of manifest.documents) {
    expectedEntries.add(`${BACKUP_ROOT}${getRecordEntry(manifest, document)}`);
    const sourceEntry = getSourceEntry(manifest, document);
    if (sourceEntry) {
      expectedEntries.add(
        `${BACKUP_ROOT}${manifest.backupFormatVersion >= BACKUP_FORMAT_VERSION ? 'sources/' : 'pdfs/'}`,
      );
      expectedEntries.add(`${BACKUP_ROOT}${sourceEntry}`);
    }
    const productivityEntry = getProductivityEntry(manifest, document);
    if (productivityEntry) {
      expectedEntries.add(`${BACKUP_ROOT}productivity/`);
      expectedEntries.add(`${BACKUP_ROOT}${productivityEntry}`);
    }
    if (document.renderedPrintPdf) {
      expectedEntries.add(`${BACKUP_ROOT}rendered-print-pdfs/`);
      expectedEntries.add(`${BACKUP_ROOT}${document.renderedPrintPdf.artifactEntry}`);
    }
  }
  return expectedEntries;
}

function getRecordEntry(
  manifest: BackupManifest,
  document: BackupManifestDocument,
): string {
  return manifest.backupFormatVersion === LEGACY_BACKUP_FORMAT_VERSION
    ? `documents/${document.documentId}.json`
    : (document.recordEntry ?? '');
}

function getSourceEntry(
  manifest: BackupManifest,
  document: BackupManifestDocument,
): string | null {
  if (manifest.backupFormatVersion >= BACKUP_FORMAT_VERSION) {
    return document.hasStoredSource
      ? (document.sourceArtifact?.sourceEntry ?? null)
      : null;
  }
  if (!document.hasStoredPdf) return null;
  return manifest.backupFormatVersion === LEGACY_BACKUP_FORMAT_VERSION
    ? `pdfs/${document.documentId}.pdf`
    : (document.pdfEntry ?? null);
}

function getProductivityEntry(
  manifest: BackupManifest,
  document: BackupManifestDocument,
): string | null {
  return manifest.backupFormatVersion >= PRODUCTIVITY_BACKUP_FORMAT_VERSION
    ? (document.productivityEntry ?? null)
    : null;
}

function assertSafeZipEntries(zip: JSZipType, entries: string[]): void {
  if (entries.some((name) => !name.startsWith(BACKUP_ROOT))) {
    throw new Error('A backup archive entry uses an unsafe path.');
  }
  const unsafeEntry = Object.values(zip.files).find((entry) => {
    const unsafeOriginalName = (entry as { unsafeOriginalName?: string })
      .unsafeOriginalName;
    return unsafeOriginalName !== undefined && unsafeOriginalName !== entry.name;
  });
  if (unsafeEntry) {
    throw new Error('A backup archive entry uses an unsafe path.');
  }
}

async function createLegacyStoredPdf(
  state: PersistedDocumentState,
  pdfBytes: Uint8Array,
): Promise<StoredDocumentSource> {
  if (
    pdfBytes.length < 5 ||
    pdfBytes[0] !== 0x25 ||
    pdfBytes[1] !== 0x50 ||
    pdfBytes[2] !== 0x44 ||
    pdfBytes[3] !== 0x46 ||
    pdfBytes[4] !== 0x2d
  ) {
    throw new Error('A stored PDF entry is invalid.');
  }

  const copiedBytes = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(copiedBytes).set(pdfBytes);
  const blob = new Blob([copiedBytes], { type: 'application/pdf' });
  return {
    documentId: state.documentId,
    documentType: 'pdf',
    fileName: state.originalFileName,
    mimeType: 'application/pdf',
    sha256: await sha256Hex(copiedBytes),
    size: blob.size,
    lastModified: state.updatedAt,
    blob,
    storedAt: Date.now(),
  };
}

async function createStoredSource(
  state: PersistedDocumentState,
  descriptor: BackupSourceArtifact,
  sourceBytes: Uint8Array,
): Promise<StoredDocumentSource> {
  if (
    descriptor.documentId !== state.documentId ||
    descriptor.documentType !== state.documentType ||
    descriptor.originalFileName !== state.originalFileName ||
    sourceBytes.byteLength !== descriptor.size
  ) {
    throw new Error('A stored source entry does not match its document record.');
  }
  const copiedBytes = new ArrayBuffer(sourceBytes.byteLength);
  new Uint8Array(copiedBytes).set(sourceBytes);
  const source: StoredDocumentSource = {
    documentId: state.documentId,
    documentType: descriptor.documentType,
    fileName: descriptor.originalFileName,
    mimeType: descriptor.mimeType,
    sha256: descriptor.sha256,
    size: descriptor.size,
    lastModified: state.updatedAt,
    blob: new Blob([copiedBytes], { type: descriptor.mimeType }),
    storedAt: Date.now(),
  };
  const validated = await validateStoredDocumentSource(source, state.documentId);
  if (!validated) {
    throw new Error('A stored source entry has invalid content or integrity metadata.');
  }
  return validated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatBackupTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toISOString().slice(0, 10)}-${date.toTimeString().slice(0, 5).replace(':', '')}`;
}

function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function loadJsZip() {
  const module = await import('jszip');
  return module.default;
}
