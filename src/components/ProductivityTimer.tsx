import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatClock,
  getDisplayedMilliseconds,
  type ClockMode,
  type ProductivityClockState as ClockState,
} from '../utils/productivityClock';

const STORAGE_KEY = '39note.productivity-clock.v1';
const DEFAULT_DURATION_MS = 25 * 60_000;
const PRESETS = [5, 15, 25, 45, 60] as const;

export function ProductivityTimer() {
  const [clock, setClock] = useState<ClockState>(loadClockState);
  const [isOpen, setIsOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [customHours, setCustomHours] = useState('0');
  const [customMinutes, setCustomMinutes] = useState('25');
  const [customSeconds, setCustomSeconds] = useState('0');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hasSignalledCompletionRef = useRef(clock.status === 'complete');

  const displayMs = useMemo(() => getDisplayedMilliseconds(clock, now), [clock, now]);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(clock));
  }, [clock]);

  useEffect(() => {
    if (clock.status !== 'running') return;
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 250);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [clock.status]);

  useEffect(() => {
    if (clock.mode !== 'timer' || clock.status !== 'running' || displayMs > 0) {
      return;
    }
    setClock((current) =>
      current.mode === 'timer' && current.status === 'running'
        ? { ...current, status: 'complete', remainingMs: 0, targetAt: undefined }
        : current,
    );
  }, [clock.mode, clock.status, displayMs]);

  useEffect(() => {
    if (clock.status === 'complete' && !hasSignalledCompletionRef.current) {
      hasSignalledCompletionRef.current = true;
      if (!clock.muted) playRestrainedChime();
    }
    if (clock.status !== 'complete') hasSignalledCompletionRef.current = false;
  }, [clock.muted, clock.status]);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (
        event instanceof PointerEvent &&
        wrapperRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
    };
  }, [isOpen]);

  const chooseTimerDuration = (durationMs: number) => {
    const normalized = Math.min(
      Math.max(Math.round(durationMs), 1_000),
      99 * 3_600_000,
    );
    setClock((current) => ({
      ...current,
      mode: 'timer',
      status: 'idle',
      durationMs: normalized,
      remainingMs: normalized,
      targetAt: undefined,
      startedAt: undefined,
    }));
    const totalSeconds = Math.floor(normalized / 1_000);
    setCustomHours(String(Math.floor(totalSeconds / 3_600)));
    setCustomMinutes(String(Math.floor((totalSeconds % 3_600) / 60)));
    setCustomSeconds(String(totalSeconds % 60));
  };

  const startOrResume = () => {
    const timestamp = Date.now();
    setNow(timestamp);
    setClock((current) => {
      if (current.mode === 'timer') {
        const remaining =
          current.status === 'complete' || current.remainingMs <= 0
            ? current.durationMs
            : current.remainingMs;
        return {
          ...current,
          status: 'running',
          remainingMs: remaining,
          targetAt: timestamp + remaining,
        };
      }
      return {
        ...current,
        status: 'running',
        startedAt: timestamp,
        accumulatedMs: current.status === 'complete' ? 0 : current.accumulatedMs,
      };
    });
  };

  const pause = () => {
    const timestamp = Date.now();
    setNow(timestamp);
    setClock((current) => {
      if (current.status !== 'running') return current;
      if (current.mode === 'timer') {
        return {
          ...current,
          status: 'paused',
          remainingMs: Math.max(0, (current.targetAt ?? timestamp) - timestamp),
          targetAt: undefined,
        };
      }
      return {
        ...current,
        status: 'paused',
        accumulatedMs:
          current.accumulatedMs +
          Math.max(0, timestamp - (current.startedAt ?? timestamp)),
        startedAt: undefined,
      };
    });
  };

  const reset = () => {
    setClock((current) => ({
      ...current,
      status: 'idle',
      remainingMs: current.durationMs,
      accumulatedMs: 0,
      targetAt: undefined,
      startedAt: undefined,
      laps: [],
    }));
    setNow(Date.now());
  };

  const setMode = (mode: ClockMode) => {
    setClock((current) => ({
      ...current,
      mode,
      status: 'idle',
      remainingMs: current.durationMs,
      accumulatedMs: 0,
      targetAt: undefined,
      startedAt: undefined,
      laps: [],
    }));
  };

  return (
    <div ref={wrapperRef} className="productivity-clock">
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`${clock.mode === 'timer' ? 'Timer' : 'Stopwatch'} ${formatClock(displayMs)}`}
        className={`toolbar-button clock-trigger ${clock.status === 'complete' ? 'is-complete' : ''}`}
        title="Timer and stopwatch"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span aria-hidden="true">⏱</span>
        <span className="clock-trigger-time">{formatClock(displayMs)}</span>
      </button>
      {isOpen ? (
        <section
          aria-label="Timer and stopwatch"
          className="clock-popover"
          role="dialog"
        >
          <div className="clock-mode-switch" role="tablist" aria-label="Clock mode">
            <button
              aria-selected={clock.mode === 'timer'}
              role="tab"
              type="button"
              onClick={() => setMode('timer')}
            >
              Timer
            </button>
            <button
              aria-selected={clock.mode === 'stopwatch'}
              role="tab"
              type="button"
              onClick={() => setMode('stopwatch')}
            >
              Stopwatch
            </button>
          </div>
          <output className="clock-display" aria-live="off">
            {formatClock(displayMs)}
          </output>
          {clock.status === 'complete' ? (
            <p className="clock-complete-message" role="status">
              Timer complete
            </p>
          ) : null}
          {clock.mode === 'timer' ? (
            <>
              <div className="clock-presets" aria-label="Timer presets">
                {PRESETS.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    onClick={() => chooseTimerDuration(minutes * 60_000)}
                  >
                    {minutes}m
                  </button>
                ))}
              </div>
              <div className="clock-custom-time">
                <label>
                  <span>Hours</span>
                  <input
                    inputMode="numeric"
                    min="0"
                    max="99"
                    type="number"
                    value={customHours}
                    onChange={(event) => setCustomHours(event.target.value)}
                  />
                </label>
                <label>
                  <span>Minutes</span>
                  <input
                    inputMode="numeric"
                    min="0"
                    max="59"
                    type="number"
                    value={customMinutes}
                    onChange={(event) => setCustomMinutes(event.target.value)}
                  />
                </label>
                <label>
                  <span>Seconds</span>
                  <input
                    inputMode="numeric"
                    min="0"
                    max="59"
                    type="number"
                    value={customSeconds}
                    onChange={(event) => setCustomSeconds(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    chooseTimerDuration(
                      (readBoundedNumber(customHours, 0, 99) * 3_600 +
                        readBoundedNumber(customMinutes, 0, 59) * 60 +
                        readBoundedNumber(customSeconds, 0, 59)) *
                        1_000,
                    )
                  }
                >
                  Set
                </button>
              </div>
            </>
          ) : null}
          <div className="clock-controls">
            {clock.status === 'running' ? (
              <button type="button" onClick={pause}>
                Pause
              </button>
            ) : (
              <button type="button" onClick={startOrResume}>
                {clock.status === 'paused' ? 'Resume' : 'Start'}
              </button>
            )}
            {clock.mode === 'stopwatch' && clock.status === 'running' ? (
              <button
                type="button"
                onClick={() =>
                  setClock((current) => ({
                    ...current,
                    laps: [
                      getDisplayedMilliseconds(current, Date.now()),
                      ...current.laps,
                    ].slice(0, 20),
                  }))
                }
              >
                Lap
              </button>
            ) : null}
            <button type="button" onClick={reset}>
              Reset
            </button>
            <button
              aria-pressed={clock.muted}
              className="clock-mute"
              type="button"
              onClick={() =>
                setClock((current) => ({ ...current, muted: !current.muted }))
              }
            >
              {clock.muted ? 'Sound off' : 'Sound on'}
            </button>
          </div>
          {clock.mode === 'stopwatch' && clock.laps.length > 0 ? (
            <ol className="clock-laps" aria-label="Stopwatch laps">
              {clock.laps.map((lap, index) => (
                <li key={`${lap}-${index}`}>
                  <span>Lap {clock.laps.length - index}</span>
                  <time>{formatClock(lap, true)}</time>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function loadClockState(): ClockState {
  const fallback: ClockState = {
    mode: 'timer',
    status: 'idle',
    durationMs: DEFAULT_DURATION_MS,
    remainingMs: DEFAULT_DURATION_MS,
    accumulatedMs: 0,
    muted: false,
    laps: [],
  };
  try {
    const value = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? 'null',
    ) as Partial<ClockState>;
    if (!value || (value.mode !== 'timer' && value.mode !== 'stopwatch'))
      return fallback;
    const durationMs = isSafeMilliseconds(value.durationMs)
      ? value.durationMs
      : DEFAULT_DURATION_MS;
    const status =
      value.status === 'running' ||
      value.status === 'paused' ||
      value.status === 'complete'
        ? value.status
        : 'idle';
    return {
      mode: value.mode,
      status,
      durationMs,
      remainingMs: isSafeMilliseconds(value.remainingMs)
        ? value.remainingMs
        : durationMs,
      accumulatedMs: isSafeMilliseconds(value.accumulatedMs) ? value.accumulatedMs : 0,
      ...(status === 'running' && typeof value.targetAt === 'number'
        ? { targetAt: value.targetAt }
        : {}),
      ...(status === 'running' && typeof value.startedAt === 'number'
        ? { startedAt: value.startedAt }
        : {}),
      muted: value.muted === true,
      laps: Array.isArray(value.laps)
        ? value.laps.filter(isSafeMilliseconds).slice(0, 20)
        : [],
    };
  } catch {
    return fallback;
  }
}

function playRestrainedChime(): void {
  try {
    const AudioContextConstructor = window.AudioContext;
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.6);
    oscillator.addEventListener('ended', () => void context.close(), { once: true });
  } catch {
    // Sound is optional and may be blocked until the browser has audio permission.
  }
}

function readBoundedNumber(value: string, minimum: number, maximum: number): number {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : minimum;
}

function isSafeMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
