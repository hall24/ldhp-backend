/**
 * Small in-memory fixed-window rate limiter, keyed by client IP. Used for the
 * unauthenticated /v1/public/* endpoints (customer response page, unsubscribe)
 * so a script cannot hammer them or guess tokens quickly.
 *
 * Per-replica only: with N replicas the effective limit is N times higher, which
 * is fine for abuse protection at pilot scale. Swap for a shared store if needed.
 */
export interface RateLimitOptions {
  /** Requests allowed per window per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one hit. Returns null when allowed, or seconds until the window resets. */
  hit(key: string): number | null {
    const t = this.now();
    this.sweep(t);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.opts.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= this.opts.max) return null;
    return Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
  }

  private sweep(t: number) {
    if (t - this.lastSweep < this.opts.windowMs) return;
    this.lastSweep = t;
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
