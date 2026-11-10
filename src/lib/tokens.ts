import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token for links (invites, intake). Never stored; only its hash is. */
export const newLinkToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Cheap shape check so junk input never reaches the database. */
export const looksLikeToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
