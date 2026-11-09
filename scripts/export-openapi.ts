/**
 * Writes openapi/openapi.json from the route schemas. Commit the result: it is
 * the contract Replit front ends build against. CI fails if it is stale.
 */
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';

const app = await buildApp({
  db: {} as Db, // never queried while generating the spec
  verifier: { verify: async () => ({ clerkUserId: 'unused' }) },
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
});
await app.ready();
writeFileSync('openapi/openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
console.log('wrote openapi/openapi.json');
