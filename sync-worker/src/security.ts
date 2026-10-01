export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'https://ex39393.github.io',
]);

export const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/u;
export const CHALLENGE_PATTERN = /^[a-zA-Z0-9_-]{43}$/u;

export function requireAllowedOrigin(request: Request): string {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin))
    throw new PublicError('origin_not_allowed', 403);
  return origin;
}

export function validateReturnUrl(value: unknown, origin: string): string {
  if (typeof value !== 'string' || value.length > 2_000)
    throw new PublicError('invalid_request', 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicError('invalid_request', 400);
  }
  if (url.origin !== origin || url.username || url.password)
    throw new PublicError('invalid_return_url', 400);
  url.hash = '';
  return url.toString();
}

export class PublicError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'PublicError';
  }
}
