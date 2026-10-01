import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptRefreshToken, encryptRefreshToken } from '../src/crypto.ts';

const key = btoa('A'.repeat(32));
const wrongKey = btoa('B'.repeat(32));

test('AES-256-GCM round trips a refresh token with a random 96-bit IV', async () => {
  const first = await encryptRefreshToken('refresh-secret', key);
  const second = await encryptRefreshToken('refresh-secret', key);
  assert.equal(
    await decryptRefreshToken(first.ciphertext, first.iv, key),
    'refresh-secret',
  );
  assert.equal(first.keyVersion, 1);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(atob(first.iv).length, 12);
});

test('AES-GCM rejects ciphertext tampering and the wrong encryption key', async () => {
  const encrypted = await encryptRefreshToken('refresh-secret', key);
  const tampered = `${encrypted.ciphertext.slice(0, -2)}AA`;
  await assert.rejects(() => decryptRefreshToken(tampered, encrypted.iv, key));
  await assert.rejects(() =>
    decryptRefreshToken(encrypted.ciphertext, encrypted.iv, wrongKey),
  );
});

test('encryption key material must be an independent 32-byte base64 value', async () => {
  await assert.rejects(
    () => encryptRefreshToken('refresh-secret', btoa('too-short')),
    /exactly 32 bytes/u,
  );
  await assert.rejects(() => encryptRefreshToken('refresh-secret', 'not base64!'));
});
