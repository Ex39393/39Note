export type ClockMode = 'timer' | 'stopwatch';
export type ClockStatus = 'idle' | 'running' | 'paused' | 'complete';

export interface ProductivityClockState {
  mode: ClockMode;
  status: ClockStatus;
  durationMs: number;
  remainingMs: number;
  accumulatedMs: number;
  targetAt?: number;
  startedAt?: number;
  muted: boolean;
  laps: number[];
}

export function getDisplayedMilliseconds(
  clock: ProductivityClockState,
  now: number,
): number {
  if (clock.mode === 'timer') {
    return clock.status === 'running'
      ? Math.max(0, (clock.targetAt ?? now) - now)
      : Math.max(0, clock.remainingMs);
  }
  return clock.status === 'running'
    ? clock.accumulatedMs + Math.max(0, now - (clock.startedAt ?? now))
    : clock.accumulatedMs;
}

export function formatClock(milliseconds: number, includeTenths = false): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const base =
    hours > 0
      ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;
  if (!includeTenths) return base;
  return `${base}.${Math.floor((Math.max(0, milliseconds) % 1_000) / 100)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
