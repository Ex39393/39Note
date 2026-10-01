import type { DriveFileMetadata } from './driveClient.ts';
import { isSha256 } from './hash.ts';
import { PAPER_PRESENCE_PROTOCOL_VERSION } from './paperPresence.ts';
import { PAPER_SYNC_PROTOCOL_VERSION, SYNC_LAYOUT_VERSION } from './paperTypes.ts';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function isRecognizedPaperRootMetadata(root: DriveFileMetadata): boolean {
  if (!isOwnedManagedPaperRootMetadata(root)) return false;
  return (
    isPaperV3RootMetadata(root) ||
    isPaperV2RootMetadata(root) ||
    isLegacyPaperRootMetadata(root)
  );
}

export function isPaperV3RootMetadata(root: DriveFileMetadata): boolean {
  if (!isOwnedManagedPaperRootMetadata(root)) return false;
  const properties = root.appProperties!;
  return (
    properties.layoutVersion === String(SYNC_LAYOUT_VERSION) &&
    properties.paperProtocolVersion === String(PAPER_SYNC_PROTOCOL_VERSION) &&
    properties.presenceProtocolVersion === String(PAPER_PRESENCE_PROTOCOL_VERSION) &&
    isSafeDriveId(properties.controlFolderId) &&
    isSha256(properties.migrationCompletionId)
  );
}

export function isPaperV2RootMetadata(root: DriveFileMetadata): boolean {
  if (!isOwnedManagedPaperRootMetadata(root)) return false;
  const properties = root.appProperties!;
  return (
    properties.layoutVersion === '2' &&
    properties.paperProtocolVersion === String(PAPER_SYNC_PROTOCOL_VERSION)
  );
}

export function isLegacyPaperRootMetadata(root: DriveFileMetadata): boolean {
  if (!isOwnedManagedPaperRootMetadata(root)) return false;
  const properties = root.appProperties!;
  return (
    properties.syncSchema === '1' &&
    properties.layoutVersion === undefined &&
    properties.paperProtocolVersion === undefined
  );
}

export function paperRootLayoutVersion(root: DriveFileMetadata): number | undefined {
  const raw = root.appProperties?.layoutVersion;
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) return Number.NaN;
  return Number(raw);
}

export function isOwnedManagedPaperRootMetadata(root: DriveFileMetadata): boolean {
  const properties = root.appProperties;
  if (
    root.mimeType !== FOLDER_MIME ||
    root.trashed === true ||
    root.ownedByMe !== true ||
    properties?.application !== '39Note' ||
    properties.role !== 'root'
  ) {
    return false;
  }
  return true;
}

function isSafeDriveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}
