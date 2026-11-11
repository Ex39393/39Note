const WORKSPACE_NAVIGATION_HANDOFF_KEY = '39note-workspace-navigation-handoff-v1';
const WORKSPACE_NAVIGATION_HANDOFF_MAX_AGE_MS = 60_000;

interface WorkspaceNavigationHandoff {
  version: 1;
  destination: 'drive';
  createdAt: number;
}

/**
 * Preserve only the UI destination needed to finish an explicit device-mode
 * switch. This marker contains no workspace, account, OAuth, or document data.
 */
export function rememberDriveAfterWorkspaceReload(now = Date.now()): void {
  if (typeof sessionStorage === 'undefined') return;
  const handoff: WorkspaceNavigationHandoff = {
    version: 1,
    destination: 'drive',
    createdAt: now,
  };
  try {
    sessionStorage.setItem(WORKSPACE_NAVIGATION_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    // Losing a UI-only return hint is safe; workspace isolation remains authoritative.
  }
}

/**
 * Read without consuming so React Strict Mode can evaluate an initial state
 * more than once and still choose the same destination.
 */
export function peekWorkspaceReloadDestination(now = Date.now()): 'drive' | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(WORKSPACE_NAVIGATION_HANDOFF_KEY) ?? 'null',
    ) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.destination !== 'drive' ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt)
    ) {
      return null;
    }
    const age = now - value.createdAt;
    return age >= 0 && age <= WORKSPACE_NAVIGATION_HANDOFF_MAX_AGE_MS ? 'drive' : null;
  } catch {
    return null;
  }
}

export function clearWorkspaceNavigationHandoff(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(WORKSPACE_NAVIGATION_HANDOFF_KEY);
  } catch {
    // The marker expires quickly and contains no sensitive state.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
