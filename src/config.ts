import { z } from 'zod';

/**
 * All configuration comes from environment variables. In dev/staging/prod these
 * are populated from Azure Key Vault (separate vault per environment) by the
 * hosting platform; locally from a git-ignored .env file. Never commit secrets.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().optional(),
  /** PEM public key for networkless JWT verification (optional). */
  CLERK_JWT_KEY: z.string().optional(),
  /** Comma-separated list of allowed origins for the `azp` claim. */
  CLERK_AUTHORIZED_PARTIES: z.string().optional(),
  /** Public base URL used in OpenAPI `servers`. */
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  /** SendGrid API key (Key Vault secret sendgrid-api-key). Absent = email sending disabled. */
  SENDGRID_API_KEY: z.string().optional(),
  /** Sending address on a domain verified in SendGrid, e.g. reminders@mail.living-data.com. */
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  /** Front-end origin that serves the customer pages /r and /unsubscribe, e.g. https://app.replit.app. */
  PUBLIC_APP_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema> & { clerkAuthorizedParties: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV !== 'test' && !cfg.CLERK_SECRET_KEY && !cfg.CLERK_JWT_KEY) {
    throw new Error('CLERK_SECRET_KEY or CLERK_JWT_KEY is required');
  }
  return {
    ...cfg,
    clerkAuthorizedParties: (cfg.CLERK_AUTHORIZED_PARTIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
