import { logger } from "../../lib/logger.ts";
import { MemoryRateLimitStore } from "./memory-store.ts";
import type { RateLimitStore } from "./types.ts";

export type { RateLimitResult, RateLimitStore } from "./types.ts";

/**
 * The in-process store, everywhere.
 *
 * A shared Redis store lived here previously and was removed deliberately. The
 * trade-off it bought back: on serverless each invocation may land on a fresh
 * process, so a per-IP counter held in memory does not hold across instances and
 * the credential endpoints are throttled per-instance rather than globally. The
 * limiter still blunts a single fast client; it is not a defence against one that
 * spreads requests around.
 *
 * Reinstating a shared store means adding a `RateLimitStore` implementation here
 * — nothing outside this module knows which one it is.
 */
export const rateLimitStore: RateLimitStore = new MemoryRateLimitStore();

logger.info({ store: rateLimitStore.name }, "rate limit store ready");
