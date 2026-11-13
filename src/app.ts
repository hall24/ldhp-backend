import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Db } from './db/client.js';
import type { TokenVerifier } from './auth/verifier.js';
import { authPlugin, ORG_HEADER } from './auth/plugin.js';
import { v1Routes } from './routes/v1.js';
import { ApiError } from './lib/errors.js';
import type { Mailer } from './lib/mailer.js';
import { FixedWindowLimiter, type RateLimitOptions } from './lib/rate-limit.js';

export interface AppDeps {
  db: Db;
  verifier: TokenVerifier;
  logger?: FastifyServerOptions['logger'];
  publicBaseUrl?: string;
  /** Serve Swagger UI at /docs (off in production by default). */
  docsUi?: boolean;
  /**
   * Browser origins allowed to call the API (exact match, e.g. https://app.replit.app).
   * Empty = no cross-origin browser access. Auth is a bearer token, so no cookies are allowed.
   */
  corsOrigins?: string[];
  /** Per-IP limit for unauthenticated /v1/public/* routes. Omit to disable (tests). */
  publicRateLimit?: RateLimitOptions;
  /**
   * Proxy hops in front of the API whose X-Forwarded-For entries are trusted for the
   * client IP (Azure Container Apps ingress = 1). Omit when the API is reached directly.
   */
  trustProxyHops?: number;
  /** Outreach email. Without a mailer, sending returns 503 email_not_configured (preview still works). */
  email?: {
    mailer?: Mailer | null;
    /** Platform sending address on a verified domain. */
    fromAddress?: string | null;
    /** Front-end origin serving /r and /unsubscribe pages. */
    appBaseUrl?: string | null;
  };
}

/**
 * The client address as the outermost trusted proxy saw it. Each trusted proxy appends
 * the address it received from, so with N trusted hops the client is the Nth entry
 * from the right of X-Forwarded-For; anything further left could be spoofed.
 */
export function clientIp(xff: string | string[] | undefined, socketAddr: string | undefined, hops: number): string {
  const fallback = socketAddr ?? 'unknown';
  if (hops <= 0 || !xff) return fallback;
  const list = (Array.isArray(xff) ? xff.join(',') : xff)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list[list.length - hops] ?? list[0] ?? fallback;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const origins = new Set(deps.corsOrigins ?? []);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !!origin && origins.has(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'x-organization-id', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'idempotent-replayed'],
    credentials: false,
    maxAge: 600,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  if (deps.publicRateLimit) {
    const limiter = new FixedWindowLimiter(deps.publicRateLimit);
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS' || !req.url.startsWith('/v1/public/')) return;
      const retryAfter = limiter.hit(clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, deps.trustProxyHops ?? 0));
      if (retryAfter === null) return;
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({
          error: {
            code: 'rate_limited',
            message: 'Too many requests. Please wait a minute and try again.',
            request_id: req.id,
          },
        });
    });
  }

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Living Data Platform API',
        version: '0.1.0',
        description:
          'R0 skeleton of the Living Data platform API. All tenant data is scoped to the organization in ' +
          `the \`${ORG_HEADER}\` header, which the server verifies against the caller's membership.`,
      },
      servers: [{ url: deps.publicBaseUrl ?? 'http://localhost:3000' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Clerk session JWT' },
        },
      },
    },
  });
  if (deps.docsUi) await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, request_id: req.id, details: err.details },
      });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: e.message, request_id: req.id, details: e.validation },
      });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply
        .code(e.statusCode)
        .send({ error: { code: 'bad_request', message: e.message, request_id: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'Internal server error.', request_id: req.id } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.', request_id: req.id } }),
  );

  await app.register(authPlugin, { db: deps.db, verifier: deps.verifier });
  await app.register(v1Routes, {
    prefix: '/v1',
    db: deps.db,
    outreach: {
      mailer: deps.email?.mailer ?? null,
      fromAddress: deps.email?.fromAddress ?? null,
      appBaseUrl: deps.email?.appBaseUrl?.replace(/\/+$/, '') ?? null,
      apiBaseUrl: (deps.publicBaseUrl ?? 'http://localhost:3000').replace(/\/+$/, ''),
    },
  });
  return app;
}
