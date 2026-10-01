export const SYNC_SOUNDS_PREFERENCE_KEY = '39note.sync-sounds.enabled.v1';

export type SyncSoundCue = 'success' | 'attention';

export interface SyncSoundTransition {
  id: number | string;
  previousStatus: string;
  currentStatus: string;
  actualWork?: boolean;
}

export interface SyncSoundPlayer {
  unlock(): void | Promise<void>;
  play(cue: SyncSoundCue): void | Promise<void>;
}

export interface SyncSoundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class SyncSoundFeedback {
  private enabledValue: boolean;
  private readonly consumedTransitions = new Set<number | string>();
  private attentionEpisodeActive = false;
  private readonly player: SyncSoundPlayer;
  private readonly storage?: SyncSoundStorage;

  constructor(player: SyncSoundPlayer, storage?: SyncSoundStorage) {
    this.player = player;
    this.storage = storage;
    this.enabledValue = readPreference(storage);
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
    try {
      this.storage?.setItem(SYNC_SOUNDS_PREFERENCE_KEY, String(enabled));
    } catch {
      // A preference write must never interfere with synchronization.
    }
  }

  unlock(): void {
    if (!this.enabledValue) return;
    try {
      void Promise.resolve(this.player.unlock()).catch(() => undefined);
    } catch {
      // Browser audio support is optional and completely non-fatal.
    }
  }

  notify(transition: SyncSoundTransition): void {
    if (this.consumedTransitions.has(transition.id)) return;
    this.consumedTransitions.add(transition.id);
    if (this.consumedTransitions.size > 100) {
      const oldest = this.consumedTransitions.values().next().value as
        number | string | undefined;
      if (oldest !== undefined) this.consumedTransitions.delete(oldest);
    }
    if (transition.previousStatus === 'attention') {
      this.attentionEpisodeActive = true;
    }
    let cue = transitionCue(transition);
    if (cue === 'attention' && this.attentionEpisodeActive) cue = null;
    if (transition.currentStatus === 'attention') {
      this.attentionEpisodeActive = true;
    } else if (!isTransientSyncStatus(transition.currentStatus)) {
      this.attentionEpisodeActive = false;
    }
    if (!this.enabledValue) return;

    if (!cue) return;
    try {
      void Promise.resolve(this.player.play(cue)).catch(() => undefined);
    } catch {
      // Audio failure must not alter sync state or surface as a sync error.
    }
  }
}

function isTransientSyncStatus(status: string): boolean {
  return (
    status === 'loading' ||
    status === 'connecting' ||
    status === 'disconnecting' ||
    status === 'syncing'
  );
}

export function transitionCue(
  transition: Omit<SyncSoundTransition, 'id'>,
): SyncSoundCue | null {
  if (
    transition.previousStatus !== 'attention' &&
    transition.currentStatus === 'attention'
  ) {
    return 'attention';
  }
  if (
    transition.actualWork === true &&
    transition.previousStatus !== 'synced' &&
    transition.currentStatus === 'synced'
  ) {
    return 'success';
  }
  return null;
}

class BrowserSyncTonePlayer implements SyncSoundPlayer {
  private context: AudioContext | null = null;
  private unlocked = false;

  async unlock(): Promise<void> {
    if (typeof window === 'undefined' || !window.AudioContext) return;
    this.context ??= new window.AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    this.unlocked = this.context.state === 'running';
  }

  async play(cue: SyncSoundCue): Promise<void> {
    const context = this.context;
    if (!context || !this.unlocked) return;
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') return;

    const now = context.currentTime;
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(cue === 'success' ? 660 : 330, now);
    if (cue === 'success') {
      oscillator.frequency.linearRampToValueAtTime(820, now + 0.11);
    } else {
      oscillator.frequency.linearRampToValueAtTime(280, now + 0.12);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.15);
    oscillator.addEventListener(
      'ended',
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
  }
}

function readPreference(storage?: SyncSoundStorage): boolean {
  try {
    const value = storage?.getItem(SYNC_SOUNDS_PREFERENCE_KEY);
    return value === null || value === undefined ? true : value !== 'false';
  } catch {
    return true;
  }
}

let singleton: SyncSoundFeedback | null = null;

export function getSyncSoundFeedback(): SyncSoundFeedback {
  singleton ??= new SyncSoundFeedback(new BrowserSyncTonePlayer(), getBrowserStorage());
  return singleton;
}

function getBrowserStorage(): SyncSoundStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
