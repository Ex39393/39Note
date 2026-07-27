import { useState } from 'react';

const DISMISSAL_PREFERENCE_KEY = '39note.web-local-data-notice-dismissed';
const isWebDeployment = import.meta.env.VITE_WEB_DEPLOYMENT === 'true';

type PersistenceResult =
  | 'Persistent storage enabled'
  | 'The browser did not grant persistent storage'
  | 'Persistent storage is unavailable in this browser';

export function WebLocalDataNotice() {
  const [isVisible, setIsVisible] = useState(
    () => isWebDeployment && !readDismissalPreference(),
  );
  const [isRequestingPersistence, setIsRequestingPersistence] = useState(false);
  const [persistenceResult, setPersistenceResult] = useState<PersistenceResult | null>(
    null,
  );

  if (!isVisible) {
    return null;
  }

  const dismiss = () => {
    writeDismissalPreference();
    setIsVisible(false);
  };

  const protectLocalStorage = async () => {
    setIsRequestingPersistence(true);
    setPersistenceResult(null);

    try {
      const storageManager = navigator.storage;
      if (!storageManager || typeof storageManager.persist !== 'function') {
        setPersistenceResult('Persistent storage is unavailable in this browser');
        return;
      }

      const isAlreadyPersistent =
        typeof storageManager.persisted === 'function'
          ? await storageManager.persisted()
          : false;
      const wasGranted = isAlreadyPersistent || (await storageManager.persist());
      setPersistenceResult(
        wasGranted
          ? 'Persistent storage enabled'
          : 'The browser did not grant persistent storage',
      );
    } catch {
      setPersistenceResult('Persistent storage is unavailable in this browser');
    } finally {
      setIsRequestingPersistence(false);
    }
  };

  return (
    <section className="web-local-data-notice" aria-label="Browser-local data">
      <p>
        Your PDFs, annotations, and Notes are stored locally in this browser. They are
        not uploaded to 39Note. Create regular backups, and avoid private browsing.
      </p>
      <div className="web-local-data-notice-actions">
        <button type="button" onClick={dismiss}>
          Got it
        </button>
        <button
          disabled={
            isRequestingPersistence ||
            persistenceResult === 'Persistent storage enabled'
          }
          type="button"
          onClick={() => void protectLocalStorage()}
        >
          {isRequestingPersistence ? 'Checking storage...' : 'Protect Local Storage'}
        </button>
      </div>
      {persistenceResult ? (
        <p className="web-local-data-result" role="status">
          {persistenceResult}
        </p>
      ) : null}
    </section>
  );
}

function readDismissalPreference(): boolean {
  try {
    return window.localStorage.getItem(DISMISSAL_PREFERENCE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDismissalPreference(): void {
  try {
    window.localStorage.setItem(DISMISSAL_PREFERENCE_KEY, 'true');
  } catch {
    // The notice can still be dismissed for the current page session.
  }
}
