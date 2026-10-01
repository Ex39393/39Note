import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYNC_SOUNDS_PREFERENCE_KEY,
  SyncSoundFeedback,
  type SyncSoundCue,
} from '../src/sync/syncSounds.ts';
import { getSyncProgressPresentation } from '../src/sync/progressPresentation.ts';

test('an unresolved attention episode does not replay its warning after a retry', () => {
  const cues: SyncSoundCue[] = [];
  const feedback = new SyncSoundFeedback({
    unlock() {},
    play(cue) {
      cues.push(cue);
    },
  });

  feedback.notify({
    id: 1,
    previousStatus: 'synced',
    currentStatus: 'attention',
  });
  feedback.notify({
    id: 2,
    previousStatus: 'attention',
    currentStatus: 'syncing',
  });
  feedback.notify({
    id: 3,
    previousStatus: 'syncing',
    currentStatus: 'attention',
    actualWork: false,
  });

  assert.deepEqual(cues, ['attention']);
});

test('a genuinely new attention episode plays one warning', () => {
  const cues: SyncSoundCue[] = [];
  const feedback = new SyncSoundFeedback({
    unlock() {},
    play(cue) {
      cues.push(cue);
    },
  });

  feedback.notify({
    id: 1,
    previousStatus: 'synced',
    currentStatus: 'attention',
  });
  feedback.notify({
    id: 2,
    previousStatus: 'attention',
    currentStatus: 'synced',
  });
  feedback.notify({
    id: 3,
    previousStatus: 'synced',
    currentStatus: 'syncing',
  });
  feedback.notify({
    id: 4,
    previousStatus: 'syncing',
    currentStatus: 'attention',
  });

  assert.deepEqual(cues, ['attention', 'attention']);
});

test('the disabled sound preference survives reconstruction', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  const player = { unlock() {}, play() {} };
  const first = new SyncSoundFeedback(player, storage);
  first.setEnabled(false);

  const second = new SyncSoundFeedback(player, storage);
  assert.equal(values.get(SYNC_SOUNDS_PREFERENCE_KEY), 'false');
  assert.equal(second.enabled, false);
});

test('non-transfer phases never imply determinate progress', () => {
  for (const phase of ['merging', 'publishing', 'verifying'] as const) {
    const itemPresentation = getSyncProgressPresentation({
      phase,
      completed: 1,
      total: 3,
    });
    const bytePresentation = getSyncProgressPresentation({
      phase,
      bytesCompleted: 512,
      bytesTotal: 1024,
    });

    assert.equal(itemPresentation?.determinate, undefined, phase);
    assert.equal(bytePresentation?.determinate, undefined, phase);
  }
});
