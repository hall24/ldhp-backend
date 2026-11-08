import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb } from './db/client.js';
import { ClerkTokenVerifier } from './auth/verifier.js';

const config = loadConfig();
const { db, close } = createPgDb(config.DATABASE_URL);
const app = await buildApp({
  db,
  verifier: new ClerkTokenVerifier({
    secretKey: config.CLERK_SECRET_KEY,
    jwtKey: config.CLERK_JWT_KEY,
    authorizedParties: config.clerkAuthorizedParties,
  }),
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
  publicBaseUrl: config.PUBLIC_BASE_URL,
  docsUi: config.NODE_ENV !== 'production',
});

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
