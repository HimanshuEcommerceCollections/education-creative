import { closeDatabase } from "../src/db/client.ts";
import { logger } from "../src/lib/logger.ts";
import { sweepUnconfirmedBookings } from "../src/services/booking-ops.service.ts";

/**
 * Refunds every paid booking whose confirmation deadline has passed.
 *
 * Taking money before a coordinator has agreed to fulfil the session is only
 * defensible because this exists: `BOOKING_POLICY.confirmationSlaDays` is a
 * promise, and this is what keeps it when nobody works the queue.
 *
 * Meant for a scheduler — `npm run bookings:sweep`, once or twice a day. Safe to
 * run as often as you like: a refunded booking is no longer `paid_unconfirmed`,
 * so a second pass finds nothing, and the Stripe call is idempotency-keyed per
 * booking. There is also an admin-only endpoint (`POST /bookings/sweep-unconfirmed`)
 * for triggering it from a session; this path exists so no session is needed.
 *
 * Refunds here are attributed to no person: the audit rows carry a null actor,
 * which is what `audit_log.actor_id` being nullable is for. A timer's refund
 * must not read as an admin's decision.
 */
async function main(): Promise<void> {
  const result = await sweepUnconfirmedBookings({
    ip: null,
    userAgent: null,
    requestId: "script:bookings:sweep",
  });

  logger.info(
    { swept: result.sweptIds.length, failed: result.failed.length },
    result.sweptIds.length === 0 && result.failed.length === 0
      ? "nothing past its confirmation deadline"
      : "sweep complete",
  );

  // A booking we couldn't refund is money still held past our own deadline. Exit
  // non-zero so a scheduler surfaces it rather than reporting a green run.
  if (result.failed.length > 0) {
    for (const failure of result.failed) {
      logger.error({ bookingId: failure.id, reason: failure.error }, "booking not refunded");
    }
    await closeDatabase();
    process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, "booking sweep failed");
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
