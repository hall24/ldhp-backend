import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb } from './db/client.js';
import { ClerkTokenVerifier } from './auth/verifier.js';
import { SendGridMailer } from './lib/mailer.js';

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
    serializers: {
      // One-click unsubscribe URLs carry a token in the path; keep it out of logs.
      req: (req: { method: string; url: string; id: string }) => ({
        method: req.method,
        url: req.url.replace(/\/public\/unsubscribe\/[^/?#]+/, '/public/unsubscribe/[redacted]'),
        id: req.id,
      }),
    },
  },
  publicBaseUrl: config.PUBLIC_BASE_URL,
  docsUi: config.NODE_ENV !== 'production',
  // The same front-end origins Clerk accepts tokens from may call the API from a browser.
  corsOrigins: config.clerkAuthorizedParties,
  email: {
    mailer: config.SENDGRID_API_KEY ? new SendGridMailer(config.SENDGRID_API_KEY) : null,
    fromAddress: config.EMAIL_FROM_ADDRESS ?? null,
    appBaseUrl: config.PUBLIC_APP_URL ?? null,
  },
});

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
