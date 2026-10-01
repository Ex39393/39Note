const FORBIDDEN_KEY =
  /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|device[-_]?session|session[-_]?token|oauth[-_]?grant|exchange[-_]?verifier|client[-_]?secret|password|authorization|cookie|customheaders?|authheaders?|x-api-key|x-goog-api-key)/iu;
const CREDENTIAL_IN_URL = /:\/\/[^\s/@:]+:[^\s/@]+@/u;

export function assertNoSecretsInSyncPayload(value: unknown): void {
  visit(value, '$');
}

export function containsSecretMarker(
  value: unknown,
  markers: readonly string[],
): boolean {
  const serialized = JSON.stringify(value);
  return markers.some((marker) => marker.length > 0 && serialized.includes(marker));
}

function visit(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => visit(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && CREDENTIAL_IN_URL.test(value)) {
      throw new Error(`Sync payload contains URL credentials at ${path}.`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`Sync payload contains forbidden field ${path}.${key}.`);
    }
    visit(child, `${path}.${key}`);
  }
}
