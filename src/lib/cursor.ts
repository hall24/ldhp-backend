import { ApiError } from './errors.js';

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

export function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof v?.t === 'string' && typeof v?.id === 'string') return v;
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'invalid_cursor', 'The pagination cursor is invalid.');
}
