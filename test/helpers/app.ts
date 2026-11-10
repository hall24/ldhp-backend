import { buildApp, type AppDeps } from '../../src/app.js';
import type { TokenVerifier } from '../../src/auth/verifier.js';
import { seedSynthetic, SEED } from '../../src/db/seed.js';
import { createTestDb } from './db.js';

/** Test tokens look like "test:<clerkUserId>". Anything else fails verification. */
export const fakeVerifier: TokenVerifier = {
  async verify(token) {
    if (!token.startsWith('test:')) throw new Error('bad token');
    return { clerkUserId: token.slice(5) };
  },
};

export const bearer = (clerkUserId: string) => ({ authorization: `Bearer test:${clerkUserId}` });

export async function setup(opts: { email?: AppDeps['email'] } = {}) {
  const { db, close } = await createTestDb();
  await seedSynthetic(db);
  const app = await buildApp({ db, verifier: fakeVerifier, email: opts.email, publicBaseUrl: 'https://api.example.test' });
  await app.ready();
  return {
    db,
    app,
    SEED,
    as: (who: { clerkUserId: string }, orgId?: string) => ({
      ...bearer(who.clerkUserId),
      ...(orgId ? { 'x-organization-id': orgId } : {}),
    }),
    teardown: async () => {
      await app.close();
      await close();
    },
  };
}
