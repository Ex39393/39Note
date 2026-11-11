export const GETTING_STARTED_PREFERENCE_KEY = '39note.getting-started.v1';

export type GettingStartedPreference = 'pending' | 'dismissed' | 'completed';

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readGettingStartedPreference(
  storage: PreferenceStorage | null = browserLocalStorage(),
): GettingStartedPreference {
  if (!storage) return 'pending';
  try {
    const value = storage.getItem(GETTING_STARTED_PREFERENCE_KEY);
    return value === 'dismissed' || value === 'completed' ? value : 'pending';
  } catch {
    return 'pending';
  }
}

export function markGettingStartedDismissed(
  storage: PreferenceStorage | null = browserLocalStorage(),
): void {
  if (!storage) return;
  try {
    if (readGettingStartedPreference(storage) !== 'completed') {
      storage.setItem(GETTING_STARTED_PREFERENCE_KEY, 'dismissed');
    }
  } catch {
    // A dismissal still applies to the current mounted view when storage is blocked.
  }
}

export function markGettingStartedCompleted(
  storage: PreferenceStorage | null = browserLocalStorage(),
): void {
  try {
    storage?.setItem(GETTING_STARTED_PREFERENCE_KEY, 'completed');
  } catch {
    // Completion persistence is optional when browser storage is unavailable.
  }
}

export function shouldAutoOpenGettingStarted({
  documentCount,
  libraryState,
  preference,
}: {
  documentCount: number;
  libraryState: 'loading' | 'ready' | 'failed';
  preference: GettingStartedPreference;
}): boolean {
  return libraryState === 'ready' && documentCount === 0 && preference === 'pending';
}

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
