const encoder = new TextEncoder();
const REFRESH_TOKEN_AAD = encoder.encode('39note-refresh-token:v1');

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  keyVersion: 1;
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64Url(bytes);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export async function encryptRefreshToken(
  refreshToken: string,
  encodedKey: string,
): Promise<EncryptedValue> {
  const key = await importEncryptionKey(encodedKey, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: REFRESH_TOKEN_AAD,
      tagLength: 128,
    },
    key,
    encoder.encode(refreshToken),
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
    keyVersion: 1,
  };
}

export async function decryptRefreshToken(
  ciphertext: string,
  iv: string,
  encodedKey: string,
): Promise<string> {
  const key = await importEncryptionKey(encodedKey, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64(iv),
      additionalData: REFRESH_TOKEN_AAD,
      tagLength: 128,
    },
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function importEncryptionKey(
  encodedKey: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(encodedKey.trim());
  } catch {
    throw new Error('TOKEN_ENCRYPTION_KEY must be base64-encoded.');
  }
  if (bytes.byteLength !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, usages);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}
