import { verifyToken } from '@clerk/backend';

export interface VerifiedIdentity {
  clerkUserId: string;
  sessionId?: string;
  /** Clerk's active org claim, if any. Informational only: never used for authorization. */
  clerkOrgId?: string;
}

/** Verifies a bearer token. Swappable so tests don't need a live Clerk instance. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

export class ClerkTokenVerifier implements TokenVerifier {
  constructor(
    private readonly opts: { secretKey?: string; jwtKey?: string; authorizedParties: string[] },
  ) {}

  async verify(token: string): Promise<VerifiedIdentity> {
    const payload = await verifyToken(token, {
      secretKey: this.opts.secretKey,
      jwtKey: this.opts.jwtKey,
      authorizedParties: this.opts.authorizedParties.length ? this.opts.authorizedParties : undefined,
    });
    if (!payload.sub) throw new Error('token has no subject');
    const p = payload as Record<string, unknown>;
    const orgClaim = (p.o as { id?: string } | undefined)?.id ?? (p.org_id as string | undefined);
    return { clerkUserId: payload.sub, sessionId: payload.sid as string | undefined, clerkOrgId: orgClaim };
  }
}
