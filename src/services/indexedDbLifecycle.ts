import { openDB, type DBSchema, type IDBPDatabase, type OpenDBCallbacks } from 'idb';

export class IndexedDbUpgradeBlockedError extends Error {
  readonly databaseName: string;
  readonly currentVersion: number;
  readonly requestedVersion: number;

  constructor(databaseName: string, currentVersion: number, requestedVersion: number) {
    super(
      'Another 39Note tab is preventing a required local database upgrade. Close or refresh the other tab and try again.',
    );
    this.name = 'IndexedDbUpgradeBlockedError';
    this.databaseName = databaseName;
    this.currentVersion = currentVersion;
    this.requestedVersion = requestedVersion;
  }
}

interface SafeOpenCallbacks<DB extends DBSchema> extends Pick<
  OpenDBCallbacks<DB>,
  'upgrade'
> {
  onConnectionClosed?(): void;
}

/**
 * Opens an additive schema upgrade without ever treating `blocked` as success.
 * If a legacy tab blocks the request, the caller fails closed immediately. The
 * browser request may later finish after that tab closes, but its connection is
 * closed and this application instance remains on its maintenance screen.
 */
export function openDatabaseWithLifecycleSafety<DB extends DBSchema>(
  databaseName: string,
  version: number,
  callbacks: SafeOpenCallbacks<DB>,
): Promise<IDBPDatabase<DB>> {
  let connection: IDBPDatabase<DB> | undefined;
  let abandoned = false;
  let rejectBlocked!: (reason: unknown) => void;
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject;
  });

  const opening = openDB<DB>(databaseName, version, {
    upgrade: callbacks.upgrade,
    blocked(currentVersion, requestedVersion) {
      abandoned = true;
      rejectBlocked(
        new IndexedDbUpgradeBlockedError(
          databaseName,
          currentVersion,
          requestedVersion ?? version,
        ),
      );
    },
    blocking() {
      connection?.close();
      callbacks.onConnectionClosed?.();
    },
    terminated() {
      callbacks.onConnectionClosed?.();
    },
  }).then((database) => {
    connection = database;
    if (abandoned) {
      database.close();
      throw new IndexedDbUpgradeBlockedError(databaseName, database.version, version);
    }
    return database;
  });

  void opening.catch(() => undefined);
  return Promise.race([opening, blocked]);
}
