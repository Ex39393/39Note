import type { SyncProgress } from './types.ts';

export interface SyncProgressPresentation {
  label: string;
  determinate?: { value: number; max: number };
}

interface AuthoritativeCount {
  kind: 'bytes' | 'items';
  completed: number;
  total: number;
}

export function getSyncProgressPresentation(
  progress: SyncProgress,
): SyncProgressPresentation | null {
  if (progress.phase === 'idle') return null;
  const count = getAuthoritativeCount(progress);
  const determinate =
    count && count.completed < count.total
      ? { value: count.completed, max: count.total }
      : undefined;
  return {
    label: progressLabel(progress, count),
    ...(determinate ? { determinate } : {}),
  };
}

function getAuthoritativeCount(progress: SyncProgress): AuthoritativeCount | null {
  if (
    (progress.phase === 'downloading' || progress.phase === 'uploading') &&
    progress.bytesCompleted !== undefined &&
    progress.bytesTotal !== undefined &&
    Number.isFinite(progress.bytesCompleted) &&
    Number.isFinite(progress.bytesTotal) &&
    progress.bytesTotal > 0
  ) {
    return {
      kind: 'bytes',
      completed: Math.max(0, Math.min(progress.bytesCompleted, progress.bytesTotal)),
      total: progress.bytesTotal,
    };
  }
  if (
    progress.phase !== 'resetting' &&
    progress.phase !== 'downloading' &&
    progress.phase !== 'uploading'
  ) {
    return null;
  }
  if (
    progress.completed === undefined ||
    progress.total === undefined ||
    !Number.isFinite(progress.completed) ||
    !Number.isFinite(progress.total) ||
    progress.total <= 1
  ) {
    return null;
  }
  return {
    kind: 'items',
    completed: Math.max(0, Math.min(progress.completed, progress.total)),
    total: progress.total,
  };
}

function progressLabel(
  progress: SyncProgress,
  count: AuthoritativeCount | null,
): string {
  switch (progress.phase) {
    case 'idle':
      return '';
    case 'connecting':
      return 'Connecting to Google Drive…';
    case 'resetting':
      return count?.kind === 'items' && count.completed < count.total
        ? `Resetting Drive sync · item ${count.completed + 1} of ${count.total}`
        : 'Resetting Drive sync…';
    case 'discovering':
      return 'Checking Drive…';
    case 'verifying':
      return 'Verifying sync…';
    case 'pulling':
      return 'Downloading changes…';
    case 'merging':
      return 'Merging changes…';
    case 'downloading':
      return transferLabel('Downloading PDF', progress, count);
    case 'uploading':
      return transferLabel('Uploading PDF', progress, count);
    case 'publishing':
      return 'Publishing sync state…';
    case 'finalizing':
      return 'Finishing sync…';
  }
}

function transferLabel(
  prefix: string,
  progress: SyncProgress,
  count: AuthoritativeCount | null,
): string {
  if (!count || count.completed >= count.total) return `${prefix.replace(' PDF', '')}…`;
  if (count.kind === 'bytes') {
    const item = currentItemLabel(progress);
    const percent = Math.min(99, Math.floor((count.completed / count.total) * 100));
    return `${prefix}${item ? ` ${item}` : ''} · ${percent}%`;
  }
  const fileName = safeDetail(progress.detail);
  return `${prefix} ${count.completed + 1} of ${count.total}${fileName ? ` · ${fileName}` : ''}`;
}

function currentItemLabel(progress: SyncProgress): string {
  if (
    progress.completed === undefined ||
    progress.total === undefined ||
    !Number.isFinite(progress.completed) ||
    !Number.isFinite(progress.total) ||
    progress.total <= 0
  ) {
    return '';
  }
  return `${Math.min(progress.completed + 1, progress.total)} of ${progress.total}`;
}

function safeDetail(detail?: string): string {
  if (!detail) return '';
  return [...detail]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || point === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
}
