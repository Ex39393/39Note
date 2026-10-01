export interface PdfOpenFailurePresentation {
  kind: 'runtime-version-mismatch' | 'password-protected' | 'invalid-pdf' | 'unknown';
  message: string;
  reloadRecommended: boolean;
}

const PDFJS_VERSION_MISMATCH_PATTERN =
  /API version ["']?[^"']+["']? does not match the Worker version ["']?[^"']+["']?/iu;

export function describePdfOpenFailure(error: unknown): PdfOpenFailurePresentation {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');

  if (PDFJS_VERSION_MISMATCH_PATTERN.test(message)) {
    return {
      kind: 'runtime-version-mismatch',
      message:
        'The PDF reader was updated while 39Note was open. Reload 39Note, then try again.',
      reloadRecommended: true,
    };
  }

  if (name === 'PasswordException') {
    return {
      kind: 'password-protected',
      message:
        'This PDF is password-protected. Remove the password from a copy, then try again.',
      reloadRecommended: false,
    };
  }

  if (name === 'InvalidPDFException') {
    return {
      kind: 'invalid-pdf',
      message: 'This PDF appears to be damaged or unsupported.',
      reloadRecommended: false,
    };
  }

  return {
    kind: 'unknown',
    message: 'This PDF could not be opened. Return to Library and try again.',
    reloadRecommended: false,
  };
}
