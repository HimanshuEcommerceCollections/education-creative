export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window, after this one. */
  remaining: number;
  /** Seconds until the window resets. Sent as `Retry-After` on a 429. */
  retryAfterSeconds: number;
}

/**
 * A fixed-window counter. Mirrors the `EmailService` shape deliberately: one
 * interface, drivers selected by config, so no route knows or cares which is
 * active.
 *
 * Fixed-window rather than sliding-window because it needs one atomic operation
 * per request. Its known weakness — up to 2× the limit across a window boundary —
 * is irrelevant here, where the numbers are "10 login attempts per 10 minutes"
 * and the real brute-force defence is per-account lockout in Postgres.
 */
export interface RateLimitStore {
  readonly name: string;

  /**
   * Increments the counter for `key` and reports the resulting state.
   *
   * Implementations must **fail open** — return `allowed: true` if the backing
   * store is unreachable. A Redis outage locking every user out of signing in
   * would be a worse failure than briefly losing the per-IP cap, and account
   * lockout still applies regardless.
   */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;

  close?(): Promise<void>;
}
