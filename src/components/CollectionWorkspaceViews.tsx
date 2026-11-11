import { useState } from 'react';
import type { LibraryDocument } from '../services/annotationPersistence.ts';
import type { CollectionRecord } from '../types/library.ts';
import {
  getCollectionPaperAvailability,
  type CollectionPaperAvailability,
} from './collectionEditorModel.ts';

function unavailableMessage(
  availability: Exclude<CollectionPaperAvailability, 'available'>,
) {
  switch (availability) {
    case 'missing-source':
      return 'Source is not stored on this device.';
    case 'unsupported-source':
      return 'This source must be converted to PDF before it can be opened.';
    case 'open-failed':
      return 'The stored source could not be opened.';
  }
}

export function CollectionView({
  collection,
  documents,
  onEdit,
  onOpenDocument,
  onOpenLibrary,
}: {
  collection: CollectionRecord;
  documents: readonly LibraryDocument[];
  onEdit(): void;
  onOpenDocument(documentId: string): Promise<boolean>;
  onOpenLibrary(): void;
}) {
  const [failedOpenDocumentIds, setFailedOpenDocumentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const openDocument = async (documentId: string) => {
    try {
      if (await onOpenDocument(documentId)) return;
    } catch {
      // The row below provides the same local recovery path for rejected opens.
    }
    setFailedOpenDocumentIds((current) => new Set(current).add(documentId));
  };

  return (
    <section className="collection-view" aria-labelledby="selected-collection-name">
      <header className="collection-detail-heading">
        <div>
          <h3 id="selected-collection-name">{collection.name}</h3>
          <p>
            {documents.length} {documents.length === 1 ? 'paper' : 'papers'}
          </p>
        </div>
        <button type="button" onClick={onEdit}>
          Edit
        </button>
      </header>
      {documents.length ? (
        <ul className="collection-paper-list">
          {documents.map((paper) => {
            const availability = getCollectionPaperAvailability(
              paper,
              failedOpenDocumentIds.has(paper.documentId),
            );
            return (
              <li key={paper.documentId}>
                {availability === 'available' ? (
                  <button
                    aria-label={`Open ${paper.displayTitle} in Reader`}
                    className="collection-paper-open"
                    type="button"
                    onClick={() => void openDocument(paper.documentId)}
                  >
                    <span>{paper.displayTitle}</span>
                    <span aria-hidden="true">Open</span>
                  </button>
                ) : (
                  <div className="collection-paper-unavailable">
                    <span className="collection-paper-unavailable-copy">
                      <span>{paper.displayTitle}</span>
                      <small role={availability === 'open-failed' ? 'alert' : 'status'}>
                        <strong>Unavailable.</strong> {unavailableMessage(availability)}
                      </small>
                    </span>
                    <button
                      aria-label={`Open Library for ${paper.displayTitle}`}
                      type="button"
                      onClick={onOpenLibrary}
                    >
                      Open Library
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>No papers in this Collection.</p>
      )}
    </section>
  );
}

export function CollectionDraftPaperList({
  action,
  disabled,
  documents,
  emptyMessage,
  onAction,
}: {
  action: 'Add' | 'Remove';
  disabled: boolean;
  documents: readonly LibraryDocument[];
  emptyMessage: string;
  onAction(documentId: string): void;
}) {
  if (!documents.length) return <p>{emptyMessage}</p>;
  return (
    <ul>
      {documents.map((paper) => (
        <li key={paper.documentId}>
          <span>{paper.displayTitle}</span>
          <button
            disabled={disabled}
            type="button"
            onClick={() => onAction(paper.documentId)}
          >
            {action}
          </button>
        </li>
      ))}
    </ul>
  );
}
