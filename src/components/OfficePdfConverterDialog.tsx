import { useEffect, useRef, useState } from 'react';
import type {
  OfficeConversionProgress,
  OfficeConversionResult,
} from '../conversion/office/types';
import {
  OFFICE_CONVERSION_ACCEPT,
  validateOfficeFileSelection,
} from '../conversion/office/validation';

export function OfficePdfConverterDialog({
  initialFile,
  onClose,
  onImportPdf,
}: {
  initialFile?: File;
  onClose(): void;
  onImportPdf(file: File): void;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(initialFile ?? null);
  const [selectedFileName, setSelectedFileName] = useState(initialFile?.name ?? '');
  const [result, setResult] = useState<OfficeConversionResult | null>(null);
  const [progress, setProgress] = useState<OfficeConversionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const chooseFile = (file: File | undefined) => {
    setResult(null);
    setProgress(null);
    setError(null);
    if (!file) {
      setSelectedFile(null);
      setSelectedFileName('');
      return;
    }
    try {
      validateOfficeFileSelection(file);
      setSelectedFile(file);
      setSelectedFileName(file.name);
    } catch (selectionError) {
      setSelectedFile(null);
      setSelectedFileName(file.name);
      setError(
        selectionError instanceof Error
          ? selectionError.message
          : 'Choose a valid DOCX or PPTX file.',
      );
    }
  };

  const convert = async () => {
    if (!selectedFile || isConverting) return;
    setError(null);
    setResult(null);
    setIsConverting(true);
    const abortController = new AbortController();
    abortRef.current = abortController;
    try {
      const { convertOfficeFileToPdf } = await import('../conversion/office/service');
      const converted = await convertOfficeFileToPdf(selectedFile, {
        signal: abortController.signal,
        onProgress: setProgress,
      });
      setResult(converted);
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (conversionError) {
      if (
        conversionError instanceof DOMException &&
        conversionError.name === 'AbortError'
      ) {
        setError('Conversion was cancelled. No paper was added.');
      } else {
        setError(
          conversionError instanceof Error
            ? conversionError.message
            : 'The Office document could not be converted.',
        );
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
      setIsConverting(false);
    }
  };

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <div className="office-converter-overlay" role="presentation">
      <section
        aria-describedby="office-converter-description"
        aria-labelledby="office-converter-title"
        aria-modal="true"
        className="office-converter-dialog"
        role="dialog"
      >
        <header>
          <div>
            <p>Local utility</p>
            <h2 id="office-converter-title">Convert Word / PowerPoint to PDF</h2>
          </div>
          <button aria-label="Close converter" type="button" onClick={close}>
            ×
          </button>
        </header>
        <p id="office-converter-description">
          Conversion stays on this device. 39Note adds only the resulting PDF; the
          original Office file is not saved, backed up, or sent to Google Drive.
        </p>

        <label className="office-converter-picker">
          <span>Choose a .docx or .pptx file</span>
          <input
            ref={inputRef}
            accept={OFFICE_CONVERSION_ACCEPT}
            disabled={isConverting}
            type="file"
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />
          <small>Legacy .doc and .ppt files are not supported yet.</small>
        </label>

        {selectedFileName ? (
          <p className="office-converter-selection">
            <strong>Selected:</strong> {selectedFileName}
          </p>
        ) : null}
        {progress ? (
          <div aria-live="polite" className="office-converter-progress" role="status">
            <span aria-hidden="true" />
            <p>{progress.message}</p>
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}

        {result ? (
          <section className="office-converter-result" aria-label="Conversion result">
            <strong>{result.file.name} is ready</strong>
            <p>
              {formatResultSummary(result)} The PDF will use 39Note’s ordinary PDF
              reader, annotations, search, Glossary, backup, and Drive sync.
            </p>
          </section>
        ) : null}

        <footer>
          {isConverting ? (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              Cancel conversion
            </button>
          ) : (
            <button type="button" onClick={close}>
              Close
            </button>
          )}
          {result ? (
            <>
              <button type="button" onClick={() => downloadPdf(result.file)}>
                Download PDF
              </button>
              <button
                className="is-primary"
                type="button"
                onClick={() => {
                  onImportPdf(result.file);
                  onClose();
                }}
              >
                Add PDF to 39Note
              </button>
            </>
          ) : (
            <button
              className="is-primary"
              disabled={!selectedFile || isConverting}
              type="button"
              onClick={() => void convert()}
            >
              {isConverting ? 'Converting…' : 'Convert locally'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function formatResultSummary(result: OfficeConversionResult): string {
  const otherIssueCount =
    result.losses.dropped + result.losses.degraded + result.losses.substituted;
  const textStatus =
    result.sourceTextCharacters > 0
      ? result.pdfTextCharacters > 0
        ? 'Selectable text was preserved.'
        : 'No selectable text was detected.'
      : 'No ordinary source text was detected.';
  const summaries = [textStatus];
  if (result.losses.unsupportedImagesOmitted > 0) {
    const count = result.losses.unsupportedImagesOmitted;
    summaries.push(
      `Converted with ${count} unsupported ${count === 1 ? 'image' : 'images'} omitted.`,
    );
  }
  if (result.losses.metadataNormalizedImages > 0) {
    const count = result.losses.metadataNormalizedImages;
    summaries.push(
      `${count} Office ${count === 1 ? 'image had' : 'images had'} inconsistent metadata and ${count === 1 ? 'was' : 'were'} safely normalized.`,
    );
  }
  if (otherIssueCount > 0) {
    summaries.push(
      `${otherIssueCount} other fidelity ${otherIssueCount === 1 ? 'limitation was' : 'limitations were'} reported.`,
    );
  }
  return summaries.join(' ');
}

function downloadPdf(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
