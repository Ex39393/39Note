import type { LibraryDocument } from '../services/annotationPersistence.ts';
import type { CollectionRecord } from '../types/library.ts';

export function CollectionView({
  collection,
  documents,
  onEdit,
}: {
  collection: CollectionRecord;
  documents: readonly LibraryDocument[];
  onEdit(): void;
}) {
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
        <ul>
          {documents.map((paper) => (
            <li key={paper.documentId}>{paper.displayTitle}</li>
          ))}
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
