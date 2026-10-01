import type {
  PaperCloudSummary,
  PaperSyncState,
  PaperSyncStatus,
} from './paperTypes.ts';

export interface PaperRemoteReminder {
  episodeId: string;
  paperIds: string[];
  dismissStage: 0 | 1 | 2;
  /** Semantic document/head states observed during this reminder episode. */
  seenStateIds: string[];
}

export function derivePaperStatus(
  state:
    | Pick<PaperSyncState, 'availability' | 'dirtyReasons' | 'incorporatedHeadIds'>
    | undefined,
  remoteHeadIds: readonly string[],
): PaperSyncStatus {
  if (!state || state.availability === 'cloud-only') return 'cloud-only';
  const dirty = state.dirtyReasons.length > 0;
  const remoteChanged = !sameSet(state.incorporatedHeadIds, remoteHeadIds);
  if (dirty && remoteChanged) return 'both-changed';
  if (dirty) return 'local-changes';
  if (remoteChanged) return 'remote-update-available';
  return 'synced';
}

/** A late local edit must survive completion of an older upload generation. */
export function settleCapturedDirtyGeneration(
  state: Pick<PaperSyncState, 'dirtyGeneration' | 'dirtyReasons'>,
  capturedGeneration: number,
): boolean {
  if (state.dirtyGeneration !== capturedGeneration) return false;
  state.dirtyReasons = [];
  return true;
}

export function defaultDirtyPaperSelection(
  states: readonly Pick<
    PaperSyncState,
    'documentId' | 'dirtyReasons' | 'cloudPresence'
  >[],
): string[] {
  return pendingSyncPaperIds(states);
}

export function pendingSyncPaperIds(
  states: readonly Pick<
    PaperSyncState,
    'documentId' | 'dirtyReasons' | 'cloudPresence'
  >[],
): string[] {
  return states
    .filter(
      (state) => state.dirtyReasons.length > 0 && state.cloudPresence !== 'removed',
    )
    .map((state) => state.documentId)
    .sort();
}

export function nextRemoteUpdateReminder(
  current: PaperRemoteReminder | undefined,
  papers: readonly Pick<PaperCloudSummary, 'documentId' | 'headIds' | 'headSetId'>[],
  states: ReadonlyMap<
    string,
    Pick<PaperSyncState, 'status'> &
      Partial<Pick<PaperSyncState, 'dismissedRemoteHeadIds'>>
  >,
  sessionSeenStateIds?: Set<string>,
): PaperRemoteReminder | undefined {
  const affected = new Map<string, Set<string>>();
  const dismissedStateIds = new Set<string>();
  for (const paper of papers) {
    const state = states.get(paper.documentId);
    const status = state?.status;
    if (status !== 'remote-update-available' && status !== 'both-changed') continue;
    const headSets = affected.get(paper.documentId) ?? new Set<string>();
    headSets.add(paper.headSetId);
    affected.set(paper.documentId, headSets);
    if (sameSet(state?.dismissedRemoteHeadIds ?? [], paper.headIds)) {
      dismissedStateIds.add(JSON.stringify([paper.documentId, paper.headSetId]));
    }
  }
  if (!affected.size) return undefined;
  const entries = [...affected.entries()].sort(([first], [second]) =>
    first.localeCompare(second),
  );
  const activeStateIds = entries.flatMap(([documentId, headSets]) =>
    [...headSets].sort().map((headSetId) => JSON.stringify([documentId, headSetId])),
  );
  const observed = sessionSeenStateIds ?? new Set<string>(current?.seenStateIds ?? []);
  const hasNewSemanticState = activeStateIds.some((stateId) => !observed.has(stateId));
  const allActiveStatesDismissed = activeStateIds.every((stateId) =>
    dismissedStateIds.has(stateId),
  );
  for (const stateId of activeStateIds) observed.add(stateId);
  const paperIds = entries.map(([documentId]) => documentId);

  if (current && !hasNewSemanticState) {
    const seenStateIds = [
      ...new Set([...current.seenStateIds, ...activeStateIds]),
    ].sort();
    const dismissStage = allActiveStatesDismissed ? 2 : current.dismissStage;
    return sameOrderedValues(current.paperIds, paperIds) &&
      sameOrderedValues(current.seenStateIds, seenStateIds) &&
      current.dismissStage === dismissStage
      ? current
      : { ...current, paperIds, seenStateIds, dismissStage };
  }
  if (!hasNewSemanticState) {
    if (!allActiveStatesDismissed) return undefined;
    return {
      episodeId: activeStateIds.join('|'),
      paperIds,
      dismissStage: 2,
      seenStateIds: [...activeStateIds],
    };
  }

  return {
    episodeId: activeStateIds.join('|'),
    paperIds,
    dismissStage: allActiveStatesDismissed ? 2 : 0,
    seenStateIds: [...activeStateIds],
  };
}

/** Record a rebuild generation only after its exact immutable publication was verified. */
export function incorporateVerifiedMigrationHead(
  state: Pick<
    PaperSyncState,
    'availability' | 'status' | 'dirtyReasons' | 'incorporatedHeadIds' | 'remoteHeadIds'
  >,
  generationId: string,
): void {
  state.availability = 'local-and-cloud';
  state.incorporatedHeadIds = [generationId];
  state.remoteHeadIds = [generationId];
  state.status = state.dirtyReasons.length ? 'local-changes' : 'synced';
}

export function advanceRemoteUpdateDismissal(
  reminder: PaperRemoteReminder,
): PaperRemoteReminder {
  return {
    ...reminder,
    dismissStage: 2,
  };
}

function sameSet(first: readonly string[], second: readonly string[]): boolean {
  return (
    first.length === second.length && first.every((value) => second.includes(value))
  );
}

function sameOrderedValues(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}
