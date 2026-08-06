import { env } from "../../env.ts";
import { logger } from "../../lib/logger.ts";
import { MemoryRateLimitStore } from "./memory-store.ts";
import type { RateLimitStore } from "./types.ts";
import { UpstashRateLimitStore } from "./upstash-store.ts";

export type { RateLimitResult, RateLimitStore } from "./types.ts";

/**
 * Upstash when it's configured, in-process otherwise. `env.ts` requires Upstash
 * in production, so the memory store can only be reached in development.
 */
function createRateLimitStore(): RateLimitStore {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashRateLimitStore(
      env.UPSTASH_REDIS_REST_URL,
      env.UPSTASH_REDIS_REST_TOKEN,
    );
  }
  return new MemoryRateLimitStore();
}

export const rateLimitStore = createRateLimitStore();

logger.info({ store: rateLimitStore.name }, "rate limit store ready");
