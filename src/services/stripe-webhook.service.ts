import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";

import { db, type Tx } from "../db/client.ts";
import {
  bookings,
  ledgerEntries,
  payments,
  stripeWebhookEvents,
} from "../db/schema/index.ts";
import { logger } from "../lib/logger.ts";
import {
  classifyOwnership,
  getStripe,
  idempotencyKey,
  readProjectTag,
  stripeWebhookSecret,
} from "../lib/stripe.ts";
import { recordAuditDetached } from "./audit.service.ts";

/**
 * The Stripe webhook. **The only source of payment truth.**
 *
 * Nothing else in this service may mark a booking paid — not the browser's
 * redirect, not Checkout's `onComplete`, not the response to `POST /bookings`. A
 * browser can be closed, spoofed, or simply wrong; a signed webhook cannot.
 *
 * ## Ownership filtering comes first
 *
 * This project may share a Stripe account with others, and a Stripe account
 * delivers every subscribed event to every registered endpoint. So before any
 * handler runs, each event is resolved to one of:
 *
 * - **ours** — carries our `metadata.project`, or names a Stripe id we hold a
 *   `payments` row for. Handled.
 * - **not ours** — carries a different project's tag. Recorded and ignored.
 * - **unknown** — no tag, and no local row naming it. Recorded and ignored.
 *
 * The distinction matters most for the orphan rule below. A succeeded
 * PaymentIntent with no local booking is refunded, because it is money taken for
 * something we cannot deliver — but *only* when it is positively tagged as ours.
 * Applied to an untagged or foreign event, that same rule would refund another
 * project's revenue. Absence of evidence is never treated as ownership.
 *
 * ## Idempotency
 *
 * Stripe retries, and a retry cheerfully redelivers an event already acted on.
 * The unique index on `stripe_webhook_events.stripe_event_id` is what makes a
 * redelivered `payment_intent.succeeded` a no-op instead of a second set of
 * ledger entries.
 */

/** Events this endpoint acts on. Register exactly these in the dashboard. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;

export function constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
  // Throws on a bad signature, which the route turns into a 400. An unsigned or
  // mis-signed body is not a payment event; it is someone probing the endpoint.
  return getStripe().webhooks.constructEvent(rawBody, signature, stripeWebhookSecret());
}

/**
 * The shape we actually read off an event's object.
 *
 * Structural rather than `Stripe.Event.Data.Object`: that type is the union of
 * every resource Stripe can send, so narrowing it costs a switch over dozens of
 * discriminants to reach three fields that are named the same on all of them.
 */
interface EventObject {
  object?: string;
  id?: string;
  payment_intent?: string | { id?: string } | null;
  metadata?: Stripe.Metadata | null;
}

function asEventObject(value: unknown): EventObject {
  return (value ?? {}) as EventObject;
}

/** The PaymentIntent id an event refers to, if any. */
function paymentIntentIdOf(value: unknown): string | null {
  const object = asEventObject(value);

  if (typeof object.payment_intent === "string") return object.payment_intent;
  if (object.payment_intent && typeof object.payment_intent === "object") {
    return object.payment_intent.id ?? null;
  }
  if (object.object === "payment_intent") return object.id ?? null;
  return null;
}

function checkoutSessionIdOf(value: unknown): string | null {
  const object = asEventObject(value);
  return object.object === "checkout.session" ? (object.id ?? null) : null;
}

interface Ownership {
  ours: boolean;
  tag: string | null;
  /** Our local payment row, when the event resolves to one. */
  paymentId: string | null;
  bookingId: string | null;
}

/**
 * Resolves an event to a local booking.
 *
 * Two independent routes to ownership, and either is sufficient:
 *
 * 1. The `project` tag matches ours. Fast, and works for objects we created.
 * 2. A `payments` row already holds the Stripe id. Authoritative, and covers the
 *    objects that don't inherit metadata — a Charge does not reliably carry its
 *    PaymentIntent's, so `charge.refunded` for one of our own payments can arrive
 *    untagged.
 *
 * A foreign tag short-circuits to "not ours" without a lookup, so a sibling
 * project's traffic costs one string comparison.
 */
async function resolveOwnership(object: unknown): Promise<Ownership> {
  const tag = readProjectTag(object);
  const verdict = classifyOwnership(object);

  if (verdict === "foreign") {
    return { ours: false, tag, paymentId: null, bookingId: null };
  }

  const intentId = paymentIntentIdOf(object);
  const sessionId = checkoutSessionIdOf(object);

  let row: { id: string; bookingId: string } | undefined;

  if (intentId) {
    [row] = await db
      .select({ id: payments.id, bookingId: payments.bookingId })
      .from(payments)
      .where(eq(payments.stripePaymentIntentId, intentId))
      .limit(1);
  }
  if (!row && sessionId) {
    [row] = await db
      .select({ id: payments.id, bookingId: payments.bookingId })
      .from(payments)
      .where(eq(payments.stripeCheckoutSessionId, sessionId))
      .limit(1);
  }

  // Metadata may also name the booking directly — the case where the session was
  // created but our `payments` insert lost a race with a very fast webhook.
  const metadataBookingId =
    verdict === "ours"
      ? (asEventObject(object).metadata?.booking_id ?? null)
      : null;

  return {
    ours: verdict === "ours" || Boolean(row),
    tag,
    paymentId: row?.id ?? null,
    bookingId: row?.bookingId ?? metadataBookingId,
  };
}

/**
 * Records the event and returns whether it is new.
 *
 * The insert is the lock: a duplicate `stripe_event_id` violates the unique index,
 * we swallow it, and the handler doesn't run twice.
 */
async function claimEvent(event: Stripe.Event, tag: string | null): Promise<boolean> {
  try {
    await db.insert(stripeWebhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      project: tag,
      payload: event as unknown as Record<string, unknown>,
    });
    return true;
  } catch (error) {
    const existing = await db
      .select({ id: stripeWebhookEvents.id })
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.stripeEventId, event.id))
      .limit(1);

    if (existing.length > 0) {
      logger.info({ eventId: event.id, type: event.type }, "stripe event already processed");
      return false;
    }
    throw error;
  }
}

async function markProcessed(
  eventId: string,
  handled: boolean,
  error?: string,
): Promise<void> {
  await db
    .update(stripeWebhookEvents)
    .set({ handled, processedAt: new Date(), error: error ?? null })
    .where(eq(stripeWebhookEvents.stripeEventId, eventId));
}

/**
 * Posts the ledger entries for a captured payment: what the platform keeps, what
 * the educator has accrued, and the real Stripe fee.
 *
 * The educator's accrual is `accrued`, not payable. A chargeback can land 60–120
 * days later, so earnings are held until a settlement window passes — which is
 * the concrete reconciliation the no-automated-payouts posture requires.
 */
async function postCaptureLedger(
  tx: Tx,
  input: {
    bookingId: string;
    currency: string;
    totalCents: number;
    educatorEarningsCents: number;
    platformMarginCents: number;
    stripeFeeCents: number | null;
    chargeId: string | null;
  },
): Promise<void> {
  await tx.insert(ledgerEntries).values([
    {
      bookingId: input.bookingId,
      account: "platform_revenue",
      direction: "credit",
      amountCents: input.platformMarginCents,
      currency: input.currency,
      status: "accrued",
      relatedStripeObjectId: input.chargeId,
    },
    {
      bookingId: input.bookingId,
      account: "educator_earnings_accrued",
      direction: "credit",
      amountCents: input.educatorEarningsCents,
      currency: input.currency,
      status: "accrued",
      relatedStripeObjectId: input.chargeId,
    },
    ...(input.stripeFeeCents !== null
      ? [
          {
            bookingId: input.bookingId,
            account: "stripe_fee" as const,
            direction: "debit",
            amountCents: input.stripeFeeCents,
            currency: input.currency,
            status: "accrued" as const,
            relatedStripeObjectId: input.chargeId,
          },
        ]
      : []),
  ]);
}

/**
 * A PaymentIntent succeeded. The one transition that turns money into a booking
 * the coordination team will see.
 *
 * Three guards, all load-bearing:
 *
 * - **Amount verification.** The captured amount must equal the frozen quote. A
 *   mismatch means something priced this outside our engine, and it is refunded
 *   rather than honoured.
 * - **Row-level serialisation.** `FOR UPDATE` on the booking, so this and the SLA
 *   auto-refund sweeper cannot both win.
 * - **Orphan refund, tag-gated.** No local booking *and* positively ours → refund
 *   and alert. Never on an untagged or foreign event.
 */
async function handlePaymentSucceeded(
  intent: Stripe.PaymentIntent,
  ownership: Ownership,
): Promise<boolean> {
  if (!ownership.bookingId) {
    /*
     * Money with nothing to deliver. Refunded only because the tag positively
     * identifies it as ours — on a shared account this is precisely the branch
     * that would otherwise reach across projects.
     */
    if (readProjectTag(intent) === null) {
      logger.warn(
        { intentId: intent.id },
        "succeeded PaymentIntent is untagged and unknown to us — ignoring, not refunding",
      );
      return false;
    }

    logger.error(
      { intentId: intent.id, amount: intent.amount_received },
      "succeeded PaymentIntent tagged as ours has no local booking — refunding",
    );

    await getStripe().refunds.create(
      { payment_intent: intent.id, reason: "duplicate" },
      { idempotencyKey: idempotencyKey("orphan-refund", intent.id) },
    );

    recordAuditDetached({
      action: "payment.orphan_refunded",
      entityType: "payment",
      entityId: intent.id,
      after: { amountCents: intent.amount_received, reason: "no local booking" },
    });
    return true;
  }

  const bookingId = ownership.bookingId;
  const charge =
    typeof intent.latest_charge === "string" ? null : (intent.latest_charge ?? null);
  const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : charge?.id ?? null;

  const balanceTransaction =
    charge && typeof charge.balance_transaction !== "string"
      ? charge.balance_transaction
      : null;

  await db.transaction(async (tx) => {
    const [booking] = await tx
      .select({
        id: bookings.id,
        status: bookings.status,
        totalCents: bookings.totalCents,
        currency: bookings.currency,
        educatorEarningsCents: bookings.educatorEarningsCents,
        platformMarginCents: bookings.platformMarginCents,
      })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for("update")
      .limit(1);

    if (!booking) {
      logger.error({ bookingId, intentId: intent.id }, "booking vanished mid-webhook");
      return;
    }

    /*
     * Amount and currency must match what we quoted. If they don't, the charge
     * did not come from our pricing engine and must not be honoured — refund it
     * rather than confirm a booking at a price nobody authorised.
     */
    const paidCents = intent.amount_received;
    const currencyMatches = intent.currency.toLowerCase() === booking.currency.toLowerCase();

    if (paidCents !== booking.totalCents || !currencyMatches) {
      logger.error(
        {
          bookingId,
          intentId: intent.id,
          expected: booking.totalCents,
          paid: paidCents,
          expectedCurrency: booking.currency,
          paidCurrency: intent.currency,
        },
        "payment amount does not match the frozen quote — refunding",
      );

      await getStripe().refunds.create(
        { payment_intent: intent.id, reason: "fraudulent" },
        { idempotencyKey: idempotencyKey("mismatch-refund", intent.id) },
      );

      await tx
        .update(payments)
        .set({ status: "refunded", stripePaymentIntentId: intent.id })
        .where(eq(payments.bookingId, bookingId));
      return;
    }

    // Already advanced past payment — a redelivery we've handled, or a refund
    // that has since happened. Either way this is not the moment to move it.
    if (booking.status !== "pending_payment") {
      logger.info(
        { bookingId, status: booking.status },
        "payment succeeded for a booking already past pending_payment — no transition",
      );
      return;
    }

    await tx
      .update(payments)
      .set({
        status: "succeeded",
        stripePaymentIntentId: intent.id,
        stripeChargeId: chargeId,
        stripeBalanceTransactionId: balanceTransaction?.id ?? null,
        amountReceivedCents: paidCents,
        stripeFeeCents: balanceTransaction?.fee ?? null,
      })
      .where(eq(payments.bookingId, bookingId));

    await tx
      .update(bookings)
      .set({ status: "paid_unconfirmed" })
      .where(eq(bookings.id, bookingId));

    await postCaptureLedger(tx, {
      bookingId,
      currency: booking.currency,
      totalCents: booking.totalCents,
      educatorEarningsCents: booking.educatorEarningsCents,
      platformMarginCents: booking.platformMarginCents,
      // The real fee, from the balance transaction — never the estimate the
      // quote used for its margin guard.
      stripeFeeCents: balanceTransaction?.fee ?? null,
      chargeId,
    });
  });

  recordAuditDetached({
    action: "booking.paid",
    entityType: "booking",
    entityId: bookingId,
    after: { status: "paid_unconfirmed", intentId: intent.id },
  });

  return true;
}

async function handleCheckoutExpired(ownership: Ownership): Promise<boolean> {
  if (!ownership.bookingId) return false;

  await db
    .update(bookings)
    .set({ status: "expired" })
    .where(and(eq(bookings.id, ownership.bookingId), eq(bookings.status, "pending_payment")));

  await db
    .update(payments)
    .set({ status: "canceled" })
    .where(
      and(
        eq(payments.bookingId, ownership.bookingId),
        inArray(payments.status, ["requires_payment", "processing"]),
      ),
    );

  return true;
}

async function handlePaymentFailed(ownership: Ownership): Promise<boolean> {
  if (!ownership.paymentId) return false;

  // The booking stays `pending_payment`: a failed card is a retry, not a dead
  // booking, and Checkout lets them try again on the same session.
  await db
    .update(payments)
    .set({ status: "failed" })
    .where(eq(payments.id, ownership.paymentId));

  return true;
}

async function handleChargeRefunded(
  charge: Stripe.Charge,
  ownership: Ownership,
): Promise<boolean> {
  if (!ownership.bookingId) return false;

  const refunded = charge.amount_refunded;
  const fully = refunded >= charge.amount;

  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({
        status: fully ? "refunded" : "partially_refunded",
        amountRefundedCents: refunded,
      })
      .where(eq(payments.bookingId, ownership.bookingId!));

    await tx
      .update(bookings)
      .set({ status: fully ? "refunded" : "partially_refunded" })
      .where(eq(bookings.id, ownership.bookingId!));

    // A reversing entry rather than an edit — the ledger is append-only, so the
    // history of what was believed and when survives the correction.
    await tx.insert(ledgerEntries).values({
      bookingId: ownership.bookingId!,
      account: "refund",
      direction: "debit",
      amountCents: refunded,
      currency: charge.currency.toUpperCase(),
      status: "reversed",
      relatedStripeObjectId: charge.id,
    });
  });

  recordAuditDetached({
    action: fully ? "booking.refunded" : "booking.partially_refunded",
    entityType: "booking",
    entityId: ownership.bookingId,
    after: { amountRefundedCents: refunded, chargeId: charge.id },
  });

  return true;
}

/**
 * A dispute hard-locks the booking. No refund path may run while one is open —
 * refunding a disputed charge loses the money twice.
 */
async function handleDispute(
  dispute: Stripe.Dispute,
  ownership: Ownership,
  closed: boolean,
): Promise<boolean> {
  if (!ownership.bookingId) return false;

  const lost = closed && dispute.status === "lost";

  await db.transaction(async (tx) => {
    await tx
      .update(bookings)
      .set({ status: "disputed" })
      .where(eq(bookings.id, ownership.bookingId!));

    await tx
      .update(payments)
      .set({ status: "disputed" })
      .where(eq(payments.bookingId, ownership.bookingId!));

    // The educator's accrual is at risk the moment a dispute opens, and reversed
    // if it's lost — otherwise a payout could be approved against money that has
    // already left the account.
    await tx
      .update(ledgerEntries)
      .set({ status: lost ? "reversed" : "at_risk" })
      .where(
        and(
          eq(ledgerEntries.bookingId, ownership.bookingId!),
          eq(ledgerEntries.account, "educator_earnings_accrued"),
        ),
      );

    if (lost) {
      await tx.insert(ledgerEntries).values({
        bookingId: ownership.bookingId!,
        account: "dispute",
        direction: "debit",
        amountCents: dispute.amount,
        currency: dispute.currency.toUpperCase(),
        status: "reversed",
        relatedStripeObjectId: dispute.id,
      });
    }
  });

  recordAuditDetached({
    action: closed ? "booking.dispute_closed" : "booking.disputed",
    entityType: "booking",
    entityId: ownership.bookingId,
    after: { disputeId: dispute.id, status: dispute.status, amountCents: dispute.amount },
  });

  return true;
}

/**
 * Dispatches a verified event.
 *
 * Returns whether this project acted on it, which the route logs and the
 * `stripe_webhook_events.handled` column records — so "we received 400 events and
 * handled 12" is visible rather than inferred, and a filter that is wrongly
 * rejecting our own traffic shows up immediately.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<boolean> {
  const object = event.data.object;
  const ownership = await resolveOwnership(object);

  const isNew = await claimEvent(event, ownership.tag);
  if (!isNew) return false;

  if (!ownership.ours) {
    logger.info(
      { eventId: event.id, type: event.type, project: ownership.tag },
      "stripe event belongs to another project — ignored",
    );
    await markProcessed(event.id, false);
    return false;
  }

  try {
    let handled = false;

    switch (event.type) {
      /*
       * Records ids only. It deliberately does **not** mark anything paid: a
       * completed Checkout Session can still be unpaid (async methods, or a
       * session completed with `payment_status: unpaid`), and treating it as
       * payment is the phantom-paid booking §8 forbids.
       */
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = object as Stripe.Checkout.Session;
        const intentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

        if (intentId) {
          await db
            .update(payments)
            .set({
              stripePaymentIntentId: intentId,
              status: session.payment_status === "paid" ? "processing" : "requires_payment",
            })
            .where(eq(payments.stripeCheckoutSessionId, session.id));
        }
        handled = true;
        break;
      }

      case "checkout.session.expired":
        handled = await handleCheckoutExpired(ownership);
        break;

      case "checkout.session.async_payment_failed":
      case "payment_intent.payment_failed":
        handled = await handlePaymentFailed(ownership);
        break;

      case "payment_intent.succeeded":
        handled = await handlePaymentSucceeded(object as Stripe.PaymentIntent, ownership);
        break;

      case "charge.refunded":
        handled = await handleChargeRefunded(object as Stripe.Charge, ownership);
        break;

      case "charge.dispute.created":
        handled = await handleDispute(object as Stripe.Dispute, ownership, false);
        break;

      case "charge.dispute.closed":
        handled = await handleDispute(object as Stripe.Dispute, ownership, true);
        break;

      default:
        logger.info({ type: event.type }, "unhandled stripe event type");
        handled = false;
    }

    await markProcessed(event.id, handled);
    return handled;
  } catch (error) {
    /*
     * Recorded and rethrown. The route answers 500 so Stripe retries, and the
     * stored row makes the failure findable — a webhook that silently swallowed
     * an error would leave a paid booking looking unpaid with no trace of why.
     */
    await markProcessed(event.id, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
