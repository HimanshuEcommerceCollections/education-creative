import { closeDatabase } from "../src/db/client.ts";
import { logger } from "../src/lib/logger.ts";
import { purgeExpiredAuthRows } from "../src/services/session.service.ts";

/**
 * Deletes the auth rows that can no longer do anything: sessions past either
 * expiry, and email tokens that are consumed or out of TTL.
 *
 * Both tables only grow otherwise — every login and every emailed link leaves a
 * row behind forever, including for accounts that were deleted years earlier.
 *
 * Meant for a scheduler — `npm run auth:purge`, daily is plenty. Safe to run as
 * often as you like: it removes only rows nothing can reference, so a second pass
 * finds less and never finds something live. There is also an admin-only endpoint
 * (`POST /auth/purge-sessions`) and a `CRON_SECRET`-authorised
 * `GET /auth/cron/purge-sessions`; this path exists so no session is needed.
 */
async function main(): Promise<void> {
  const result = await purgeExpiredAuthRows();

  logger.info(
    result,
    result.sessions === 0 && result.emailTokens === 0
      ? "nothing to purge"
      : "purge complete",
  );
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, "purge failed");
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
