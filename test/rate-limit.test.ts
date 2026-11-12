import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FixedWindowLimiter } from '../src/lib/rate-limit.js';
import { seedSynthetic } from '../src/db/seed.js';
import { createTestDb } from './helpers/db.js';
import { fakeVerifier } from './helpers/app.js';

describe('FixedWindowLimiter', () => {
  it('allows max hits per window per key, then resets', () => {
    let now = 0;
    const l = new FixedWindowLimiter({ max: 2, windowMs: 60_000 }, () => now);
    expect(l.hit('a')).toBeNull();
    expect(l.hit('a')).toBeNull();
    expect(l.hit('a')).toBe(60);
    expect(l.hit('b')).toBeNull();
    now = 30_000;
    expect(l.hit('a')).toBe(30);
    now = 60_000;
    expect(l.hit('a')).toBeNull();
  });
});

describe('public route rate limit', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDb();
    close = t.close;
    await seedSynthetic(t.db);
    app = await buildApp({ db: t.db, verifier: fakeVerifier, publicRateLimit: { max: 3, windowMs: 60_000 }, trustProxyHops: 1 });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await close();
  });

  const view = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/public/intake/view',
      payload: { token: 'not-a-real-token' },
      headers: { 'x-forwarded-for': ip },
    });

  it('returns 429 with retry-after after the limit, per client IP', async () => {
    for (let i = 0; i < 3; i++) expect((await view('203.0.113.9')).statusCode).not.toBe(429);
    const blocked = await view('203.0.113.9');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(blocked.json().error.code).toBe('rate_limited');
    expect((await view('198.51.100.4')).statusCode).not.toBe(429);
  });

  it('uses the address the proxy saw, not one the client spoofed in front of it', async () => {
    for (let i = 0; i < 3; i++) await view('192.0.2.1');
    expect((await view('10.9.9.9, 192.0.2.1')).statusCode).toBe(429);
  });

  it('does not limit signed-in routes', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { 'x-forwarded-for': '203.0.113.9' } });
      expect(res.statusCode).not.toBe(429);
    }
  });
});
