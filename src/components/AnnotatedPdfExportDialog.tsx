import { useEffect, useState } from 'react';
import type {
  AnnotatedPdfExportOptions,
  AnnotatedPdfExportProgress,
} from '../types/annotatedPdfExport';

interface AnnotatedPdfExportDialogProps {
  annotationCount: number;
  visibleAnnotationCount: number;
  noteCount: number;
  visibleNoteCount: number;
  isExporting: boolean;
  progress: AnnotatedPdfExportProgress | null;
  error: string | null;
  onClose: () => void;
  onExport: (options: AnnotatedPdfExportOptions) => void;
}

const DEFAULT_OPTIONS: AnnotatedPdfExportOptions = {
  contentMode: 'annotations-and-notes',
  includeAnnotationColors: true,
  includeSelectedText: true,
  includeHiddenAnnotations: true,
  includeReferenceMarkers: true,
};

export function AnnotatedPdfExportDialog({
  annotationCount,
  visibleAnnotationCount,
  noteCount,
  visibleNoteCount,
  isExporting,
  progress,
  error,
  onClose,
  onExport,
}: AnnotatedPdfExportDialogProps) {
  const [options, setOptions] = useState<AnnotatedPdfExportOptions>(DEFAULT_OPTIONS);
  const exportedCount = options.includeHiddenAnnotations
    ? annotationCount
    : visibleAnnotationCount;
  const exportedNoteCount = options.includeHiddenAnnotations
    ? noteCount
    : visibleNoteCount;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isExporting) {
        onClose();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isExporting, onClose]);

  return (
    <div className="annotated-pdf-dialog-backdrop" role="presentation">
      <section
        aria-label="Export Annotated PDF"
        aria-modal="true"
        className="annotated-pdf-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p>Document export</p>
            <h2>Export Annotated PDF</h2>
          </div>
          <button disabled={isExporting} type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <fieldset disabled={isExporting}>
          <legend>Content</legend>
          <label>
            <input
              checked={options.contentMode === 'annotations'}
              name="annotated-pdf-content"
              type="radio"
              onChange={() =>
                setOptions((current) => ({
                  ...current,
                  contentMode: 'annotations',
                }))
              }
            />
            Highlights and underlines
          </label>
          <label>
            <input
              checked={options.contentMode === 'annotations-and-notes'}
              name="annotated-pdf-content"
              type="radio"
              onChange={() =>
                setOptions((current) => ({
                  ...current,
                  contentMode: 'annotations-and-notes',
                }))
              }
            />
            Highlights, underlines, and Notes appendix
          </label>
        </fieldset>

        <fieldset disabled={isExporting}>
          <legend>Options</legend>
          <label>
            <input
              checked={options.includeAnnotationColors}
              type="checkbox"
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  includeAnnotationColors: event.target.checked,
                }))
              }
            />
            Include annotation colors
          </label>
          <label>
            <input
              checked={options.includeSelectedText}
              disabled={options.contentMode !== 'annotations-and-notes'}
              type="checkbox"
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  includeSelectedText: event.target.checked,
                }))
              }
            />
            Include selected source text in Notes appendix
          </label>
          <label>
            <input
              checked={options.includeHiddenAnnotations}
              type="checkbox"
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  includeHiddenAnnotations: event.target.checked,
                }))
              }
            />
            Include annotations hidden by the current filter
          </label>
          <label>
            <input
              checked={options.includeReferenceMarkers}
              disabled={options.contentMode !== 'annotations-and-notes'}
              type="checkbox"
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  includeReferenceMarkers: event.target.checked,
                }))
              }
            />
            Add appendix reference markers near source annotations
          </label>
        </fieldset>

        <p className="annotated-pdf-export-scope">
          {options.includeHiddenAnnotations
            ? `All document annotations: ${exportedCount}`
            : `Annotations visible under the current filter: ${exportedCount} of ${annotationCount}`}
          {options.contentMode === 'annotations-and-notes'
            ? ` | ${exportedNoteCount} Notes available`
            : ''}
        </p>

        {progress ? (
          <p className="annotated-pdf-progress" role="status">
            {progress.message}
          </p>
        ) : null}
        {error ? (
          <p className="annotated-pdf-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <button disabled={isExporting} type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="toolbar-button-primary"
            disabled={isExporting}
            type="button"
            onClick={() => onExport(options)}
          >
            {isExporting ? 'Exporting...' : 'Export Annotated PDF'}
          </button>
        </footer>
      </section>
    </div>
  );
}
