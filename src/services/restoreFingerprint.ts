import { sha256Hex, stableStringify } from '../sync/hash.ts';

/**
 * Hashes the complete structured-clone value, including Blob bytes. The normal
 * sync canonicalizer intentionally treats a Blob as an empty object, which is
 * insufficient for restore preimages and commit verification.
 */
export async function fingerprintRestoreValue(value: unknown): Promise<string> {
  return sha256Hex(
    stableStringify(await normalizeRestoreFingerprintValue(value, new WeakSet())),
  );
}

async function normalizeRestoreFingerprintValue(
  value: unknown,
  ancestors: WeakSet<object>,
): Promise<unknown> {
  if (value === undefined) return { $39noteType: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Restore data contains a non-finite number.');
    }
    return value;
  }
  if (value instanceof Blob) {
    return {
      $39noteType: 'blob',
      mimeType: value.type,
      sha256: await sha256Hex(value),
      size: value.size,
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      $39noteType: 'array-buffer',
      byteLength: value.byteLength,
      sha256: await sha256Hex(value),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice().buffer;
    return {
      $39noteType: value.constructor.name,
      byteLength: value.byteLength,
      sha256: await sha256Hex(bytes),
    };
  }
  if (typeof value !== 'object') {
    throw new Error('Restore data contains an unsupported value.');
  }
  if (ancestors.has(value)) {
    throw new Error('Restore data contains a cyclic value.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Promise.all(
        value.map((item) => normalizeRestoreFingerprintValue(item, ancestors)),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Restore data contains a non-record object.');
    }
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([key, child]) => [
        key,
        await normalizeRestoreFingerprintValue(child, ancestors),
      ]),
    );
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}
