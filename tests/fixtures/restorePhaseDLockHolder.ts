import { acquireSharedWorkspaceRestoreLease } from '../../src/services/workspaceRestoreLock.ts';

const channelId = new URL(location.href).searchParams.get('channel');
if (!channelId || !window.opener) {
  throw new Error('The isolated restore-lock holder is missing its opener context.');
}

let held: Awaited<ReturnType<typeof acquireSharedWorkspaceRestoreLease>> | undefined;

window.addEventListener('message', async (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== window.opener ||
    !event.data ||
    event.data.channelId !== channelId
  ) {
    return;
  }
  if (event.data.command === 'acquire' && !held) {
    held = await acquireSharedWorkspaceRestoreLease();
    window.opener.postMessage({ channelId, type: 'acquired' }, location.origin);
    return;
  }
  if (event.data.command === 'release' && held) {
    const current = held;
    held = undefined;
    current.release();
    await current.settled;
    window.opener.postMessage({ channelId, type: 'released' }, location.origin);
  }
});

window.opener.postMessage({ channelId, type: 'ready' }, location.origin);
