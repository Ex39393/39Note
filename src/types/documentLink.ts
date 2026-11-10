import type { PdfSemanticAnchor } from '../documents/anchors';

/** One stable end of a same-document PDF text Link. */
export interface PdfLinkEndpoint {
  id: string;
  anchor: PdfSemanticAnchor;
  createdAt: number;
}

/**
 * A first-class, one-to-one relationship between at most two PDF text sources.
 * `id` is authoritative; `visibleNumber` is document-scoped display metadata.
 */
export interface DocumentLink {
  version: 1;
  type: 'link';
  id: string;
  documentId: string;
  visibleNumber: number;
  /** Optional custom label; presentation derives `Link N` when omitted. */
  name?: string;
  endpointA: PdfLinkEndpoint;
  endpointB?: PdfLinkEndpoint;
  createdAt: number;
  updatedAt: number;
}

export interface PairedDocumentLink extends DocumentLink {
  endpointB: PdfLinkEndpoint;
}

/**
 * Monotonic document-scoped Link allocation state. Sync merges this record by
 * maximum `nextLinkNumber`; it is never derived from only the currently-live
 * Links because deleted visible numbers remain consumed.
 */
export interface DocumentLinkNumberHighWater {
  version: 1;
  type: 'link-number-high-water';
  documentId: string;
  nextLinkNumber: number;
}

export function isPairedDocumentLink(link: DocumentLink): link is PairedDocumentLink {
  return link.endpointB !== undefined;
}
