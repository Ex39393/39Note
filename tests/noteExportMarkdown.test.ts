import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type { Note } from '../src/types/note.ts';

type NoteExportModule = typeof import('../src/utils/noteExport.ts');

let server: ViteDevServer;
let exportNotesAsMarkdown: NoteExportModule['exportNotesAsMarkdown'];

before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  const noteExport = (await server.ssrLoadModule(
    '/src/utils/noteExport.ts',
  )) as NoteExportModule;
  exportNotesAsMarkdown = noteExport.exportNotesAsMarkdown;
});

after(async () => {
  await server?.close();
});

test('Markdown Notes export fails closed before touching browser APIs when there are no Notes', () => {
  assert.equal(exportNotesAsMarkdown([], 'Empty paper'), false);
});

test('Markdown Notes export downloads the current Notes with a safe filename and releases its URL', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
    URL,
    'createObjectURL',
  );
  const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
    URL,
    'revokeObjectURL',
  );
  const blobs: Blob[] = [];
  const revokedUrls: string[] = [];
  const links: Array<{
    href: string;
    download: string;
    clicks: number;
    removals: number;
  }> = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback: () => void) {
        callback();
        return 1;
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body: {
        append() {},
      },
      createElement(tagName: string) {
        assert.equal(tagName, 'a');
        const state = { href: '', download: '', clicks: 0, removals: 0 };
        links.push(state);
        return {
          get href() {
            return state.href;
          },
          set href(value: string) {
            state.href = value;
          },
          get download() {
            return state.download;
          },
          set download(value: string) {
            state.download = value;
          },
          click() {
            state.clicks += 1;
          },
          remove() {
            state.removals += 1;
          },
        };
      },
    },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value(blob: Blob) {
      blobs.push(blob);
      return `blob:39note-notes-${blobs.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value(url: string) {
      revokedUrls.push(url);
    },
  });

  try {
    const note: Note = {
      id: 'note-1',
      annotationId: 'annotation-1',
      pageNumber: 4,
      displayNumber: '2',
      selectedText: 'Research *evidence* \\ source',
      content: 'Interpretation with **intentional Markdown**.',
      createdAt: 1,
      updatedAt: 2,
    };

    assert.equal(exportNotesAsMarkdown([note], 'Paper: draft.pdf'), true);
    assert.equal(links.length, 1);
    assert.deepEqual(links[0], {
      href: 'blob:39note-notes-1',
      download: 'Paper- draft.pdf-notes.md',
      clicks: 1,
      removals: 1,
    });
    assert.deepEqual(revokedUrls, ['blob:39note-notes-1']);
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].type, 'text/markdown;charset=utf-8');
    assert.equal(
      await blobs[0].text(),
      '*Research \\*evidence\\* \\\\ source*\n\n2. Interpretation with **intentional Markdown**.',
    );
  } finally {
    restoreProperty(globalThis, 'window', originalWindow);
    restoreProperty(globalThis, 'document', originalDocument);
    restoreProperty(URL, 'createObjectURL', originalCreateObjectUrl);
    restoreProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
  }
});

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}
