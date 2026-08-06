/**
 * Verifies the rate limiter directly, without HTTP or a database.
 *
 * Exercises the in-process store's arithmetic and window expiry, and — when
 * Upstash credentials are present — the same contract against real Redis, so the
 * two drivers are known to behave identically.
 *
 *   npx tsx scripts/rate-limit-check.ts
 */
import { MemoryRateLimitStore } from "../src/services/rate-limit/memory-store.ts";
import { UpstashRateLimitStore } from "../src/services/rate-limit/upstash-store.ts";
import type { RateLimitStore } from "../src/services/rate-limit/types.ts";
import { env } from "../src/env.ts";

let failures = 0;
const ok = (label: string, condition: boolean, detail = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

/** A distinct key per run so a real Redis isn't polluted between invocations. */
const suffix = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

async function exerciseStore(store: RateLimitStore, label: string) {
  console.log(`\n— ${label} —`);

  const key = `test:basic:${suffix}`;
  const first = await store.consume(key, 3, 60);
  ok("first request is allowed", first.allowed, `remaining ${first.remaining}`);
  ok("remaining counts down from the limit", first.remaining === 2, `${first.remaining}`);

  const second = await store.consume(key, 3, 60);
  const third = await store.consume(key, 3, 60);
  ok("requests up to the limit are allowed", second.allowed && third.allowed);
  ok("remaining reaches zero at the limit", third.remaining === 0, `${third.remaining}`);

  const fourth = await store.consume(key, 3, 60);
  ok("the request past the limit is refused", !fourth.allowed);
  ok(
    "a refusal reports a positive retry delay",
    fourth.retryAfterSeconds > 0 && fourth.retryAfterSeconds <= 60,
    `${fourth.retryAfterSeconds}s`,
  );

  // Independent keys must not share a budget — otherwise one noisy address
  // would lock out everyone.
  const otherKey = `test:isolation:${suffix}`;
  const other = await store.consume(otherKey, 3, 60);
  ok("a different key has its own budget", other.allowed && other.remaining === 2);

  // A 1-second window proves expiry actually releases the budget.
  const shortKey = `test:expiry:${suffix}`;
  await store.consume(shortKey, 1, 1);
  const blocked = await store.consume(shortKey, 1, 1);
  ok("the second request in a 1s window is refused", !blocked.allowed);

  await new Promise((resolve) => setTimeout(resolve, 1400));
  const afterExpiry = await store.consume(shortKey, 1, 1);
  ok("the window expires and the budget returns", afterExpiry.allowed);

  await store.close?.();
}

await exerciseStore(new MemoryRateLimitStore(), "memory store");

if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  await exerciseStore(
    new UpstashRateLimitStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN),
    "upstash store (real Redis)",
  );
} else {
  console.log(
    "\n— upstash store —\nSKIP  no UPSTASH_REDIS_REST_URL/TOKEN set; only the memory store was checked",
  );
}

console.log("\n— failing open —");
// A store that cannot be reached must allow the request rather than refuse it: a
// Redis outage should not lock every user out of signing in.
const brokenStore = new UpstashRateLimitStore(
  "https://unreachable.invalid",
  "not-a-real-token",
);
const failOpen = await brokenStore.consume(`test:failopen:${suffix}`, 1, 60);
ok("an unreachable store allows the request", failOpen.allowed);

console.log(
  failures === 0 ? "\nAll rate limit checks passed.\n" : `\n${failures} failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
