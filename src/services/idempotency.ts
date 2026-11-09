import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys } from '../db/schema.js';
import type { ScopedContext } from './context.js';
import type { Db } from '../db/client.js';
import { ApiError } from '../lib/errors.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');

/**
 * Run `fn` at most once per (org, account, key). A retry with the same key and
 * body replays the stored response; the same key with a different body is
 * rejected (PRD §9: retries must not create duplicate records).
 *
 * The key row is reserved inside the same transaction as the work, so a
 * concurrent duplicate blocks on the unique index until the first commits (then
 * replays) or rolls back (then runs).
 */
export async function withIdempotency(
  ctx: ScopedContext,
  key: string | undefined,
  requestBody: unknown,
  fn: (scoped: ScopedContext) => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (!key) return { ...(await fn(ctx)), replayed: false };
  if (key.length > 200) throw new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key is too long.');
  if (!ctx.actor.accountId) throw new Error('idempotency requires an account actor');
  const accountId = ctx.actor.accountId;
  const requestHash = hash(requestBody);
  const where = and(
    eq(idempotencyKeys.organizationId, ctx.organizationId),
    eq(idempotencyKeys.accountId, accountId),
    eq(idempotencyKeys.key, key),
  );

  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const reserved = await tx
      .insert(idempotencyKeys)
      .values({
        organizationId: ctx.organizationId,
        accountId,
        key,
        requestHash,
        responseStatus: 0,
        responseBody: {},
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (reserved.length === 0) {
      const [row] = await tx.select().from(idempotencyKeys).where(where).limit(1);
      if (!row || row.responseStatus === 0) {
        throw new ApiError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is in progress.');
      }
      if (row.requestHash !== requestHash) {
        throw new ApiError(
          422,
          'idempotency_key_reused',
          'Idempotency-Key was already used with a different request.',
        );
      }
      return { status: row.responseStatus, body: row.responseBody, replayed: true };
    }

    const result = await fn({ ...ctx, db: tx });
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: result.status, responseBody: result.body as object })
      .where(where);
    return { ...result, replayed: false };
  });
}
