import { logger } from "../../lib/logger.ts";
import type { RateLimitResult, RateLimitStore } from "./types.ts";

/**
 * Increment and set the expiry in one round trip.
 *
 * A Lua script rather than `INCR` followed by `EXPIRE`: those are two commands,
 * and a process dying between them leaves a key with no TTL — which would block
 * that client permanently rather than for one window.
 */
const INCR_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
`;

/**
 * Upstash Redis over its **REST API**, not the Redis wire protocol.
 *
 * That's the point: serverless invocations are short-lived and can't reuse a TCP
 * connection, so a normal Redis client either reconnects constantly or exhausts
 * the connection limit. REST is a stateless HTTPS call per operation, which also
 * means it works on hosts that block non-HTTP egress.
 */
export class UpstashRateLimitStore implements RateLimitStore {
  readonly name = "upstash";

  private client: unknown = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async getClient() {
    if (this.client) return this.client as import("@upstash/redis").Redis;

    const { Redis } = await import("@upstash/redis");
    this.client = new Redis({ url: this.url, token: this.token });
    return this.client as import("@upstash/redis").Redis;
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      const redis = await this.getClient();
      const [count, ttl] = (await redis.eval(
        INCR_WITH_TTL,
        [key],
        [windowSeconds],
      )) as [number, number];

      const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;

      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds,
      };
    } catch (error) {
      // Fail open. Losing the per-IP cap during a Redis outage is a smaller
      // failure than refusing every sign-in, and per-account lockout still holds.
      logger.error(
        { err: error, key },
        "rate-limit store unreachable — allowing the request (failing open)",
      );
      return { allowed: true, remaining: limit, retryAfterSeconds: windowSeconds };
    }
  }
}
