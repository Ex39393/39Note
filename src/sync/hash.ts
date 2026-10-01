function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => compareCanonicalStrings(first, second))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function compareCanonicalStrings(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value: Blob | ArrayBuffer | string): Promise<string> {
  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Blob
        ? await value.arrayBuffer()
        : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
