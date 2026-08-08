import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const identity = '39Note::local-pdf-reader::v1';

async function probe(url: string): Promise<number> {
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(projectRoot, 'Open 39Note When Ready.ps1'),
        '-Url',
        url,
        '-ProbeOnly',
      ],
      { windowsHide: true },
    );
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
}

test('the static application identity matches the launcher expectation', async () => {
  const appIdentity = await readFile(
    join(projectRoot, 'public', '39note-app-id.txt'),
    'utf8',
  );
  const html = await readFile(join(projectRoot, 'index.html'), 'utf8');

  assert.equal(appIdentity.trim(), identity);
  assert.match(html, /<meta name="application-name" content="39Note" \/>/);
});

test(
  'the Windows launcher probe distinguishes 39Note, an unrelated HTTP app, and a free port',
  { skip: process.platform !== 'win32' },
  async () => {
    let rootRequests = 0;
    let identityRequests = 0;
    let responseIdentity = identity;
    const server = createServer((request, response) => {
      if (request.url === '/') {
        rootRequests += 1;
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>Test application</title>');
        return;
      }

      if (request.url === '/39note-app-id.txt') {
        identityRequests += 1;
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(responseIdentity);
        return;
      }

      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;

    try {
      assert.equal(await probe(url), 0);
      assert.equal(rootRequests, 1);
      assert.equal(identityRequests, 1);

      responseIdentity = '<!doctype html><title>Another Vite app</title>';
      assert.equal(await probe(url), 2);
      assert.equal(rootRequests, 2);
      assert.equal(identityRequests, 2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    assert.equal(await probe(url), 1);
  },
);
