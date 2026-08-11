import type JSZipType from 'jszip';
import {
  getBackupDocumentData,
  listLibraryDocuments,
  listCollections,
  listTags,
  restoreLibraryEntities,
  restoreBackupDocument,
  validateBackupDocumentState,
  type PersistedDocumentState,
  type StoredPdfFile,
} from './annotationPersistence';
import type { CollectionRecord, TagRecord } from '../types/library';
import {
  getArchiveEntryKey,
  isSafeLegacyDocumentIdForArchive,
  isValidDocumentId,
} from '../utils/documentId';
import {
  getProductivityBackupData,
  restoreProductivityBackupData,
  sanitizeProductivityBackupData,
  type ProductivityBackupDocument,
} from './productivityPersistence';

export const BACKUP_FORMAT_VERSION = 3;
const PREVIOUS_BACKUP_FORMAT_VERSION = 2;
const LEGACY_BACKUP_FORMAT_VERSION = 1;
const BACKUP_ROOT = '39note-backup/';

export interface BackupManifestDocument {
  documentId: string;
  hasStoredPdf: boolean;
  recordEntry?: string;
  pdfEntry?: string;
  productivityEntry?: string;
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
}

export interface RestorePreview {
  manifest: BackupManifest;
  documents: Array<{ state: PersistedDocumentState; pdf: StoredPdfFile | null }>;
  conflictCount: number;
  pdfCount: number;
  highlightCount: number;
  underlineCount: number;
  noteCount: number;
  collections: CollectionRecord[];
  tags: TagRecord[];
  productivity: ProductivityBackupDocument[];
}

export async function downloadLibraryBackup(
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  const documents = await getBackupDocumentData();
  const [collections, tags] = await Promise.all([listCollections(), listTags()]);
  await downloadBackupArchive(documents, collections, tags, 'library', onProgress);
}

export async function downloadSelectedPackage(
  documentIds: readonly string[],
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  const uniqueIds = [...new Set(documentIds)];
  const documents = await getBackupDocumentData(uniqueIds);
  if (documents.length !== uniqueIds.length) {
    throw new Error('One or more selected documents could not be packaged.');
  }
  const referencedCollectionIds = new Set(documents.flatMap(({ state }) => state.collectionIds));
  const referencedTagIds = new Set(documents.flatMap(({ state }) => state.tagIds));
  const [allCollections, allTags] = await Promise.all([listCollections(), listTags()]);
  await downloadBackupArchive(
    documents,
    allCollections.filter((collection) => referencedCollectionIds.has(collection.id)),
    allTags.filter((tag) => referencedTagIds.has(tag.id)),
    'selected',
    onProgress,
  );
}

async function downloadBackupArchive(
  documents: Awaited<ReturnType<typeof getBackupDocumentData>>,
  collections: CollectionRecord[],
  tags: TagRecord[],
  scope: 'library' | 'selected',
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  const productivity = await getProductivityBackupData(
    documents.map(({ state }) => state.documentId),
  );
  const productivityByDocument = new Map(
    productivity.map((record) => [record.documentId, record] as const),
  );
  const manifest: BackupManifest = {
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    application: '39Note',
    createdAt: Date.now(),
    documentCount: documents.length,
    annotationCount: documents.reduce((count, document) => count + document.state.annotations.length, 0),
    noteCount: documents.reduce((count, document) => count + document.state.notes.length, 0),
    documents: documents.map(({ state, pdf }) => {
      const record = productivityByDocument.get(state.documentId);
      return createManifestDocument(
        state.documentId,
        Boolean(pdf),
        Boolean(record?.printDraft || record?.aiConversations.length),
      );
    }),
    backupScope: scope,
    printDraftCount: productivity.filter((record) => record.printDraft).length,
    aiConversationCount: productivity.reduce(
      (count, record) => count + record.aiConversations.length,
      0,
    ),
    ...(scope === 'selected' ? { selectedDocumentCount: documents.length } : {}),
  };

  zip.file(`${BACKUP_ROOT}manifest.json`, JSON.stringify(manifest));
  zip.file(`${BACKUP_ROOT}collections.json`, JSON.stringify(collections));
  zip.file(`${BACKUP_ROOT}tags.json`, JSON.stringify(tags));
  for (const [index, document] of documents.entries()) {
    const manifestDocument = manifest.documents[index];
    zip.file(`${BACKUP_ROOT}${manifestDocument.recordEntry}`, JSON.stringify(document.state));
    if (document.pdf && manifestDocument.pdfEntry) {
      zip.file(`${BACKUP_ROOT}${manifestDocument.pdfEntry}`, document.pdf.blob);
    }
    const productivityRecord = productivityByDocument.get(document.state.documentId);
    if (manifestDocument.productivityEntry && productivityRecord) {
      zip.file(
        `${BACKUP_ROOT}${manifestDocument.productivityEntry}`,
        JSON.stringify(productivityRecord),
      );
    }
    onProgress(index + 1, documents.length);
    await yieldToBrowser();
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const prefix = scope === 'selected'
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

  const manifest = parseManifest(JSON.parse(await manifestFile.async('text')));
  const expectedEntries = getExpectedEntries(manifest);
  expectedEntries.add(`${BACKUP_ROOT}collections.json`);
  expectedEntries.add(`${BACKUP_ROOT}tags.json`);
  if (entries.some((name) => !expectedEntries.has(name))) {
    throw new Error('A backup archive entry is unexpected or unsafe.');
  }

  const documents = await Promise.all(manifest.documents.map(async (manifestDocument, index) => {
    const recordEntry = getRecordEntry(manifest, manifestDocument);
    const stateFile = zip.file(`${BACKUP_ROOT}${recordEntry}`);
    if (!stateFile) {
      throw new Error(`Backup document ${index + 1} is missing its record.`);
    }

    const state = validateBackupDocumentState(JSON.parse(await stateFile.async('text')));
    if (!state) {
      throw new Error(`Backup document ${index + 1} has an invalid record.`);
    }
    if (state.documentId !== manifestDocument.documentId) {
      throw new Error(`Backup document ${index + 1} does not match the identifier in the manifest.`);
    }

    const pdfEntry = getPdfEntry(manifest, manifestDocument);
    const pdfFile = pdfEntry ? zip.file(`${BACKUP_ROOT}${pdfEntry}`) : null;
    if (manifestDocument.hasStoredPdf !== Boolean(pdfFile)) {
      throw new Error(`Backup document ${index + 1} has an inconsistent PDF entry.`);
    }

    const pdf = pdfFile ? createStoredPdf(state, await pdfFile.async('uint8array')) : null;
    const productivityEntry = getProductivityEntry(manifest, manifestDocument);
    const productivityFile = productivityEntry
      ? zip.file(`${BACKUP_ROOT}${productivityEntry}`)
      : null;
    if (Boolean(productivityEntry) !== Boolean(productivityFile)) {
      throw new Error(`Backup document ${index + 1} has inconsistent productivity data.`);
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
    return { state, pdf, productivity };
  }));
  const collections = await readEntities<CollectionRecord>(zip, 'collections.json');
  const tags = await readEntities<TagRecord>(zip, 'tags.json');

  const existingIds = new Set((await listLibraryDocuments()).map((document) => document.documentId));
  return {
    manifest,
    documents,
    conflictCount: documents.filter(({ state }) => existingIds.has(state.documentId)).length,
    pdfCount: documents.filter(({ pdf }) => pdf).length,
    highlightCount: documents.reduce((count, { state }) => count + state.annotations.filter((annotation) => annotation.type === 'highlight').length, 0),
    underlineCount: documents.reduce((count, { state }) => count + state.annotations.filter((annotation) => annotation.type === 'underline').length, 0),
    noteCount: documents.reduce((count, { state }) => count + state.notes.length, 0),
    collections,
    tags,
    productivity: documents.flatMap((document) =>
      document.productivity ? [document.productivity] : [],
    ),
  };
}

export async function restoreBackup(preview: RestorePreview, replaceExisting: boolean): Promise<{ imported: number; failed: number }> {
  const existingIds = new Set((await listLibraryDocuments()).map((document) => document.documentId));
  let imported = 0;
  let failed = 0;
  const restoredDocumentIds = new Set<string>();
  for (const document of preview.documents) {
    if (existingIds.has(document.state.documentId) && !replaceExisting) continue;
    if (await restoreBackupDocument(document.state, document.pdf, replaceExisting)) {
      imported += 1;
      restoredDocumentIds.add(document.state.documentId);
    }
    else failed += 1;
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
  return Array.isArray(value) ? value as T[] : [];
}

function createManifestDocument(
  documentId: string,
  hasStoredPdf: boolean,
  hasProductivityData: boolean,
): BackupManifestDocument {
  if (!isValidDocumentId(documentId)) {
    throw new Error('A Library document has an invalid identifier and cannot be backed up.');
  }

  const archiveKey = getArchiveEntryKey(documentId);
  return {
    documentId,
    hasStoredPdf,
    recordEntry: `documents/${archiveKey}.json`,
    ...(hasStoredPdf ? { pdfEntry: `pdfs/${archiveKey}.pdf` } : {}),
    ...(hasProductivityData
      ? { productivityEntry: `productivity/${archiveKey}.json` }
      : {}),
  };
}

function parseManifest(value: unknown): BackupManifest {
  if (!isRecord(value)) {
    throw new Error('Backup manifest is invalid.');
  }
  if (
    typeof value.backupFormatVersion !== 'number' ||
    (value.backupFormatVersion !== BACKUP_FORMAT_VERSION &&
      value.backupFormatVersion !== PREVIOUS_BACKUP_FORMAT_VERSION &&
      value.backupFormatVersion !== LEGACY_BACKUP_FORMAT_VERSION) ||
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
  const documents = value.documents.map((document, index) => parseManifestDocument(
    document,
    index,
    backupFormatVersion,
  ));
  if (new Set(documents.map((document) => document.documentId)).size !== documents.length) {
    throw new Error('Backup manifest contains duplicate document identifiers.');
  }
  if (
    value.backupScope === 'selected'
    && (!Number.isInteger(value.selectedDocumentCount) || value.selectedDocumentCount !== documentCount)
  ) {
    throw new Error('Selective package manifest counts are invalid.');
  }

  return {
    backupFormatVersion,
    application: '39Note',
    createdAt,
    documentCount,
    annotationCount: typeof value.annotationCount === 'number' ? value.annotationCount : 0,
    noteCount: typeof value.noteCount === 'number' ? value.noteCount : 0,
    documents,
    backupScope: value.backupScope === 'selected' ? 'selected' : 'library',
    ...(value.backupScope === 'selected' && typeof value.selectedDocumentCount === 'number'
      ? { selectedDocumentCount: value.selectedDocumentCount }
      : {}),
    printDraftCount: typeof value.printDraftCount === 'number' ? value.printDraftCount : 0,
    aiConversationCount:
      typeof value.aiConversationCount === 'number' ? value.aiConversationCount : 0,
  };
}

function parseManifestDocument(
  value: unknown,
  index: number,
  backupFormatVersion: number,
): BackupManifestDocument {
  if (!isRecord(value) || !isValidDocumentId(value.documentId)) {
    throw new Error(`Backup document ${index + 1} has a missing or invalid identifier.`);
  }
  if (typeof value.hasStoredPdf !== 'boolean') {
    throw new Error(`Backup document ${index + 1} has invalid PDF metadata.`);
  }

  if (backupFormatVersion === LEGACY_BACKUP_FORMAT_VERSION) {
    if (!isSafeLegacyDocumentIdForArchive(value.documentId)) {
      throw new Error(`Backup document ${index + 1} uses an unsupported legacy identifier format.`);
    }
    return { documentId: value.documentId, hasStoredPdf: value.hasStoredPdf };
  }

  const expectedKey = getArchiveEntryKey(value.documentId);
  const expectedRecordEntry = `documents/${expectedKey}.json`;
  const expectedPdfEntry = `pdfs/${expectedKey}.pdf`;
  const expectedProductivityEntry = `productivity/${expectedKey}.json`;
  if (value.recordEntry !== expectedRecordEntry || (value.hasStoredPdf && value.pdfEntry !== expectedPdfEntry)) {
    throw new Error(`Backup document ${index + 1} has an unsafe archive entry path.`);
  }
  if (!value.hasStoredPdf && value.pdfEntry !== undefined) {
    throw new Error(`Backup document ${index + 1} has inconsistent PDF metadata.`);
  }
  if (
    backupFormatVersion === BACKUP_FORMAT_VERSION &&
    value.productivityEntry !== undefined &&
    value.productivityEntry !== expectedProductivityEntry
  ) {
    throw new Error(`Backup document ${index + 1} has an unsafe productivity entry path.`);
  }
  if (
    backupFormatVersion !== BACKUP_FORMAT_VERSION &&
    value.productivityEntry !== undefined
  ) {
    throw new Error(`Backup document ${index + 1} has unsupported productivity metadata.`);
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

function getExpectedEntries(manifest: BackupManifest): Set<string> {
  const expectedEntries = new Set<string>([
    BACKUP_ROOT,
    `${BACKUP_ROOT}documents/`,
    `${BACKUP_ROOT}manifest.json`,
  ]);
  for (const document of manifest.documents) {
    expectedEntries.add(`${BACKUP_ROOT}${getRecordEntry(manifest, document)}`);
    const pdfEntry = getPdfEntry(manifest, document);
    if (pdfEntry) {
      expectedEntries.add(`${BACKUP_ROOT}pdfs/`);
      expectedEntries.add(`${BACKUP_ROOT}${pdfEntry}`);
    }
    const productivityEntry = getProductivityEntry(manifest, document);
    if (productivityEntry) {
      expectedEntries.add(`${BACKUP_ROOT}productivity/`);
      expectedEntries.add(`${BACKUP_ROOT}${productivityEntry}`);
    }
  }
  return expectedEntries;
}

function getRecordEntry(manifest: BackupManifest, document: BackupManifestDocument): string {
  return manifest.backupFormatVersion === LEGACY_BACKUP_FORMAT_VERSION
    ? `documents/${document.documentId}.json`
    : document.recordEntry ?? '';
}

function getPdfEntry(manifest: BackupManifest, document: BackupManifestDocument): string | null {
  if (!document.hasStoredPdf) {
    return null;
  }
  return manifest.backupFormatVersion === LEGACY_BACKUP_FORMAT_VERSION
    ? `pdfs/${document.documentId}.pdf`
    : document.pdfEntry ?? null;
}

function getProductivityEntry(
  manifest: BackupManifest,
  document: BackupManifestDocument,
): string | null {
  return manifest.backupFormatVersion === BACKUP_FORMAT_VERSION
    ? document.productivityEntry ?? null
    : null;
}

function assertSafeZipEntries(zip: JSZipType, entries: string[]): void {
  if (entries.some((name) => !name.startsWith(BACKUP_ROOT))) {
    throw new Error('A backup archive entry uses an unsafe path.');
  }
  const unsafeEntry = Object.values(zip.files).find((entry) => {
    const unsafeOriginalName = (entry as { unsafeOriginalName?: string }).unsafeOriginalName;
    return unsafeOriginalName !== undefined && unsafeOriginalName !== entry.name;
  });
  if (unsafeEntry) {
    throw new Error('A backup archive entry uses an unsafe path.');
  }
}

function createStoredPdf(state: PersistedDocumentState, pdfBytes: Uint8Array): StoredPdfFile {
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
    fileName: state.originalFileName,
    mimeType: 'application/pdf',
    size: blob.size,
    lastModified: state.updatedAt,
    blob,
    storedAt: Date.now(),
  };
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
