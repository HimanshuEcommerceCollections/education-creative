import type { RateLimitResult, RateLimitStore } from "./types.ts";

interface Window {
  count: number;
  resetAtMs: number;
}

/**
 * In-process fixed-window counter, and the only store this app has.
 *
 * Exact for a single instance. On more than one (or any serverless platform) each
 * process keeps its own count, so the effective limit multiplies by the instance
 * count and a client that spreads requests around is not held. That is a known,
 * accepted limitation — see the note in `index.ts`.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly name = "memory";

  private readonly windows = new Map<string, Window>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    // Expired entries are only dropped lazily on access, so a sweep stops keys
    // that are never revisited from accumulating forever.
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAtMs <= now) {
      this.windows.set(key, { count: 1, resetAtMs: now + windowSeconds * 1000 });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: windowSeconds };
    }

    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000));

    return {
      allowed: existing.count <= limit,
      remaining: Math.max(0, limit - existing.count),
      retryAfterSeconds,
    };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (window.resetAtMs <= now) this.windows.delete(key);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.windows.clear();
  }
}
