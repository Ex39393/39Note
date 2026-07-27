export type NavigationDiagnosticEvent =
  | 'open-request-created'
  | 'waiting-for-annotation-hydration'
  | 'annotation-target-resolved'
  | 'saved-position-selected'
  | 'page-one-selected'
  | 'invalid-target-fallback-selected'
  | 'navigation-applied'
  | 'request-consumed'
  | 'stale-request-ignored';

interface NavigationDiagnosticDetails {
  requestId?: string;
  documentId?: string;
  source?: string;
  targetType?: string;
  annotationId?: string;
  pageNumber?: number;
  fallback?: string;
  generation?: number;
  navigationEpoch?: number;
  reason?: string;
}

export function logNavigationDiagnostic(
  event: NavigationDiagnosticEvent,
  details: NavigationDiagnosticDetails = {},
): void {
  if (!import.meta.env.DEV) {
    return;
  }

  console.debug('[39Note navigation]', {
    event,
    ...details,
  });
}
