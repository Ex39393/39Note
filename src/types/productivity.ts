export const PRINT_DRAFT_SCHEMA_VERSION = 2 as const;

export type PrintContentMode = 'notes-and-glossary' | 'all-annotations';

export type PrintTemplateId = 'normal' | 'space-saving' | 'extra-large';

export interface PrintTemplateOverrides {
  pageMarginTopMm?: number;
  pageMarginRightMm?: number;
  pageMarginBottomMm?: number;
  pageMarginLeftMm?: number;
  contentWidthMm?: number;
  bodyFontSizePt?: number;
  bodyLineHeight?: number;
  titleFontSizePt?: number;
  blockSpacingPt?: number;
  noteSpacingPt?: number;
  glossarySpacingPt?: number;
  annotationSpacingPt?: number;
}

export interface PrintDraftAddition {
  id: string;
  kind: 'ai-result' | 'custom';
  label: string;
  content: string;
  createdAt: number;
}

export interface PrintDraftRecord {
  draftSchemaVersion: typeof PRINT_DRAFT_SCHEMA_VERSION;
  documentId: string;
  sourceFingerprint: string;
  sourceModelVersion: number;
  editorStateJson: string;
  contentMode: PrintContentMode;
  baseTemplateId: PrintTemplateId;
  templateVersion: 1;
  overrides: PrintTemplateOverrides;
  createdAt: number;
  updatedAt: number;
  lastSavedAt: number;
  pendingAdditions: PrintDraftAddition[];
}

/**
 * Metadata for a future Print Composer renderer that returns real PDF bytes.
 * Browser print-dialog completion alone must never create this descriptor.
 */
export interface RenderedPrintPdfDescriptor {
  kind: 'rendered-print-pdf';
  documentId: string;
  fileName: string;
  mimeType: 'application/pdf';
  size: number;
  sha256: string;
  renderedFromDraftHash: string;
  createdAt: number;
  fileId?: string;
}

/** A validated, locally stored PDF selected after the browser Save-as-PDF flow. */
export interface StoredRenderedPrintPdf extends RenderedPrintPdfDescriptor {
  blob: Blob;
  storedAt: number;
}

export type RenderedPrintPdfState = 'missing' | 'current' | 'stale';

export type AiMessageRole = 'user' | 'assistant';

export interface AiChatMessage {
  id: string;
  role: AiMessageRole;
  content: string;
  createdAt: number;
  status?: 'streaming' | 'complete' | 'error' | 'stopped';
  pages?: number[];
  contextCharacters?: number;
}

export interface AiConversationRecord {
  id: string;
  documentId: string;
  title: string;
  messages: AiChatMessage[];
  promptProfileId: string;
  createdAt: number;
  updatedAt: number;
}
