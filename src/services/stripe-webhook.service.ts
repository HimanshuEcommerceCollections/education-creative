import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { db, type Tx } from "../db/client.ts";
import {
  auditLog,
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

/**
 * Events this endpoint acts on. Register exactly these in the dashboard.
 *
 * Load-bearing rather than documentation: the dispatch below narrows against
 * this list, so a type added here without a `case` fails to compile and a `case`
 * for a type not listed here is dead code. The exported list and the switch
 * cannot drift.
 */
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
  /**
   * A refund Stripe accepted and the bank later rejected. Without these the
   * booking reads `refunded`, the parent has been emailed "refunded in full",
   * and the money is still in the account with nothing to catch it.
   */
  "refund.failed",
  "refund.updated",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/** The event type as one we handle, or null. */
function handledEventType(type: string): HandledEventType | null {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type)
    ? (type as HandledEventType)
    : null;
}

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
 * Records the event and returns whether it is ours to handle now.
 *
 * The insert is the lock: a duplicate `stripe_event_id` violates the unique index,
 * we swallow it, and the handler doesn't run twice.
 *
 * **A failed attempt is not a duplicate.** The claim row is written before the
 * handler runs and in its own transaction, so a handler that throws leaves the
 * row behind with an `error` and nothing done. Treating that as "already
 * processed" is how a transient failure permanently drops an event: Stripe
 * retries, the row exists, we answer 200, and a charged parent's booking stays
 * `pending_payment` forever. So a row carrying an error is re-claimable, and the
 * error is cleared as part of claiming it — conditionally, in one statement, so
 * two concurrent retries cannot both decide they own it.
 *
 * A row with `error IS NULL` was handled or deliberately ignored, and stays a
 * duplicate.
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
    const [existing] = await db
      .select({ id: stripeWebhookEvents.id, error: stripeWebhookEvents.error })
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.stripeEventId, event.id))
      .limit(1);

    if (!existing) throw error;

    if (existing.error !== null) {
      const reclaimed = await db
        .update(stripeWebhookEvents)
        .set({
          error: null,
          handled: false,
          processedAt: null,
          // The retry carries the current payload, which is the one the handler
          // is about to act on.
          payload: event as unknown as Record<string, unknown>,
        })
        .where(
          and(
            eq(stripeWebhookEvents.stripeEventId, event.id),
            sql`${stripeWebhookEvents.error} is not null`,
          ),
        )
        .returning({ id: stripeWebhookEvents.id });

      if (reclaimed.length > 0) {
        logger.warn(
          { eventId: event.id, type: event.type },
          "retrying a stripe event whose previous attempt failed",
        );
        return true;
      }
    }

    logger.info({ eventId: event.id, type: event.type }, "stripe event already processed");
    return false;
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
 *
 * The credits sum to the amount received, and the fee appears exactly once as a
 * debit. `bookings.platformMarginCents` is deliberately not used here: that
 * figure is already net of the quote-time *estimated* fee, so crediting it and
 * then debiting the actual fee counted the fee twice and lost roughly $3.20 per
 * $100 booking out of a ledger that could then never balance. The column stays
 * what it is — a display figure and the input to the margin guard.
 */
async function postCaptureLedger(
  tx: Tx,
  input: {
    bookingId: string;
    currency: string;
    totalCents: number;
    educatorEarningsCents: number;
    stripeFeeCents: number | null;
    chargeId: string | null;
  },
): Promise<void> {
  await tx.insert(ledgerEntries).values([
    {
      bookingId: input.bookingId,
      account: "platform_revenue",
      direction: "credit",
      // The gross take, before Stripe's cut — which the debit below carries.
      amountCents: input.totalCents - input.educatorEarningsCents,
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
 * The `payments` row this attempt belongs to, or null when the booking has none.
 *
 * By the intent first, then by the booking's live attempt: `createBooking`
 * inserts the row with a null `stripePaymentIntentId` and only
 * `checkout.session.completed` fills it in, so a real charge can arrive before
 * any row names it. Never booking-wide — a booking can carry earlier attempts,
 * and writing this intent's id across all of them violates `payments_intent_key`.
 */
async function attemptRowId(
  tx: Tx,
  bookingId: string,
  intentId: string,
): Promise<string | null> {
  const [byIntent] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, intentId))
    .limit(1);
  if (byIntent) return byIntent.id;

  const [live] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.bookingId, bookingId),
        inArray(payments.status, ["requires_payment", "processing"]),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);

  return live?.id ?? null;
}

/**
 * The settled attempt on a booking — the row that took money and is therefore
 * the only one anything can be refunded against.
 */
async function settledPaymentRow(tx: Tx, bookingId: string) {
  const [row] = await tx
    .select({
      id: payments.id,
      amountReceivedCents: payments.amountReceivedCents,
      amountRefundedCents: payments.amountRefundedCents,
    })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), gt(payments.amountReceivedCents, 0)))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  return row ?? null;
}

/**
 * Writes the record of money that arrived: the Stripe ids, the amount received
 * and the real fee.
 *
 * Unconditional, because these are facts rather than a transition. A branch that
 * returns before writing them leaves a real charge with no `stripeChargeId` — the
 * money is invisible to `refundableCents`, `refundBooking` refuses, and the only
 * way to return it is the Stripe dashboard.
 *
 * Inserts when the booking has no `payments` row at all. `createBooking` writes
 * that row *after* the Checkout Session exists, so a lost insert leaves the
 * booking resolvable by `metadata.booking_id` with nothing to update — and a
 * booking that reads paid with no payments row can never be refunded either.
 */
async function recordSettlement(
  tx: Tx,
  input: {
    bookingId: string;
    paymentId: string | null;
    currency: string;
    intent: Stripe.PaymentIntent;
    chargeId: string | null;
    balanceTransactionId: string | null;
    feeCents: number | null;
    status: "succeeded" | "refunded";
  },
): Promise<void> {
  const money = {
    stripePaymentIntentId: input.intent.id,
    stripeChargeId: input.chargeId,
    stripeBalanceTransactionId: input.balanceTransactionId,
    amountReceivedCents: input.intent.amount_received,
    stripeFeeCents: input.feeCents,
  } as const;

  /*
   * Which current statuses this one may advance from. The amounts and ids above
   * are facts and go in unconditionally; the status is a transition, and Stripe
   * redelivers — so a `payment_intent.succeeded` arriving after the charge was
   * refunded or disputed must not walk the row backwards to `succeeded`.
   */
  const advanceFrom =
    input.status === "succeeded"
      ? (["requires_payment", "processing", "failed", "succeeded"] as const)
      : ([
          "requires_payment",
          "processing",
          "failed",
          "succeeded",
          "partially_refunded",
          "refunded",
        ] as const);

  const target =
    input.paymentId ?? (await attemptRowId(tx, input.bookingId, input.intent.id));

  if (target) {
    await tx.update(payments).set(money).where(eq(payments.id, target));
    await tx
      .update(payments)
      .set({ status: input.status })
      .where(and(eq(payments.id, target), inArray(payments.status, [...advanceFrom])));
    return;
  }

  logger.error(
    { bookingId: input.bookingId, intentId: input.intent.id },
    "no payments row for a settled intent — recording one from the event",
  );

  await tx.insert(payments).values({
    bookingId: input.bookingId,
    currency: input.currency,
    amountCents: input.intent.amount,
    status: input.status,
    ...money,
  });
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
      /*
       * No `entityId`. That column is a `uuid`, so a Stripe id put in it is
       * rejected by Postgres — and `recordAuditDetached` swallows the failure, so
       * the one branch that moves money with no human involvement produced no
       * audit row at all. The Stripe id belongs in the payload.
       */
      after: {
        intentId: intent.id,
        amountCents: intent.amount_received,
        reason: "no local booking",
      },
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

  let transitioned = false;

  await db.transaction(async (tx) => {
    const [booking] = await tx
      .select({
        id: bookings.id,
        status: bookings.status,
        totalCents: bookings.totalCents,
        currency: bookings.currency,
        educatorEarningsCents: bookings.educatorEarningsCents,
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

      // Scoped to this intent's own row, not every attempt on the booking: the
      // others may be a live session or an earlier decline, and neither is
      // refunded.
      await recordSettlement(tx, {
        bookingId,
        paymentId: ownership.paymentId,
        currency: booking.currency,
        intent,
        chargeId,
        balanceTransactionId: balanceTransaction?.id ?? null,
        feeCents: balanceTransaction?.fee ?? null,
        status: "refunded",
      });

      /*
       * The booking moves too. Left `pending_payment` it keeps a live SLA
       * deadline the sweep can't act on — money already returned, a deadline
       * that never fires, and a polling client waiting on a state that will
       * never resolve.
       */
      await tx
        .update(bookings)
        .set({ status: "refunded" })
        .where(eq(bookings.id, bookingId));
      return;
    }

    /*
     * The ids and the amount are written whatever the booking's status. This is
     * the record of money that genuinely arrived, and the branch below returns
     * without a transition — a redelivery we've handled, or a refund that has
     * since happened — but never without recording the charge.
     */
    await recordSettlement(tx, {
      bookingId,
      paymentId: ownership.paymentId,
      currency: booking.currency,
      intent,
      chargeId,
      balanceTransactionId: balanceTransaction?.id ?? null,
      // The real fee, from the balance transaction — never the estimate the
      // quote used for its margin guard.
      feeCents: balanceTransaction?.fee ?? null,
      status: "succeeded",
    });

    if (booking.status !== "pending_payment") {
      /*
       * `error`, not `info`. A redelivery is harmless, but so is a charge that
       * arrived on a booking something else already moved — and the second is a
       * real reconciliation problem that nobody looks for at `info`.
       */
      logger.error(
        { bookingId, status: booking.status, intentId: intent.id, chargeId },
        "payment succeeded for a booking already past pending_payment — ids recorded, no transition",
      );
      return;
    }

    await tx
      .update(bookings)
      .set({ status: "paid_unconfirmed" })
      .where(eq(bookings.id, bookingId));

    await postCaptureLedger(tx, {
      bookingId,
      currency: booking.currency,
      totalCents: booking.totalCents,
      educatorEarningsCents: booking.educatorEarningsCents,
      stripeFeeCents: balanceTransaction?.fee ?? null,
      chargeId,
    });

    transitioned = true;
  });

  if (transitioned) {
    recordAuditDetached({
      action: "booking.paid",
      entityType: "booking",
      entityId: bookingId,
      after: { status: "paid_unconfirmed", intentId: intent.id },
    });
  }

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

/**
 * A payment attempt failed. The booking stays `pending_payment`: a declined card
 * is a retry, not a dead booking, and Checkout lets them try again.
 *
 * Resolved by booking when the intent doesn't name a row, which is the ordinary
 * case rather than an edge one — for a freshly created embedded Checkout Session
 * `payments.stripePaymentIntentId` is still null, and only
 * `checkout.session.completed` fills it in, which does not fire for a declined
 * card. Without the fallback the *first* decline on every booking went
 * unrecorded.
 */
async function handlePaymentFailed(ownership: Ownership): Promise<boolean> {
  if (!ownership.paymentId && !ownership.bookingId) return false;

  const scope = ownership.paymentId
    ? eq(payments.id, ownership.paymentId)
    : and(
        eq(payments.bookingId, ownership.bookingId!),
        inArray(payments.status, ["requires_payment", "processing"]),
      );

  const updated = await db
    .update(payments)
    .set({ status: "failed" })
    .where(scope)
    .returning({ id: payments.id });

  if (updated.length === 0) {
    logger.warn(
      { bookingId: ownership.bookingId },
      "payment failed but no live attempt row to record it on",
    );
    return false;
  }

  return true;
}

/**
 * A refund settled at Stripe, whoever issued it — this endpoint or the dashboard.
 *
 * Stripe reports `amount_refunded` **cumulatively** and fires this once per
 * refund, so the running total is a `SET` and the ledger entry is the *delta*.
 * Posting the cumulative figure each time made $30 then $30 read as $90 against
 * $60 truly refunded, in an append-only table that cannot be corrected.
 *
 * A booking that has since gone to `disputed` keeps that status. `disputed` is a
 * hard lock — `refundBooking` refuses on it precisely so a charge the bank is
 * clawing back can't be paid out a second time — and `partially_refunded` is in
 * `REFUNDABLE_STATUSES`, so letting a late refund event overwrite the lock
 * unlocks exactly what the lock exists to prevent. The bookkeeping still runs;
 * only the status transition is withheld.
 */
async function handleChargeRefunded(
  charge: Stripe.Charge,
  ownership: Ownership,
): Promise<boolean> {
  if (!ownership.bookingId) return false;

  const bookingId = ownership.bookingId;
  const refunded = charge.amount_refunded;
  const fully = refunded >= charge.amount;

  const outcome = await db.transaction(async (tx) => {
    const [booking] = await tx
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for("update")
      .limit(1);

    const disputed = booking?.status === "disputed";

    /*
     * Read and written inside one transaction, under the booking's row lock. The
     * delta is the difference against what we last recorded, and two
     * `charge.refunded` events that both read the same "previous" figure post the
     * same debit twice.
     */
    const payment = await settledPaymentRow(tx, bookingId);
    const deltaCents = refunded - (payment?.amountRefundedCents ?? 0);

    if (payment) {
      await tx
        .update(payments)
        .set({
          amountRefundedCents: refunded,
          ...(disputed ? {} : { status: fully ? "refunded" : "partially_refunded" }),
        })
        .where(eq(payments.id, payment.id));
    } else {
      logger.error(
        { bookingId, chargeId: charge.id },
        "refund settled on a booking with no settled payment row",
      );
    }

    if (!disputed) {
      await tx
        .update(bookings)
        .set({ status: fully ? "refunded" : "partially_refunded" })
        .where(eq(bookings.id, bookingId));
    }

    // A reversing entry rather than an edit — the ledger is append-only, so the
    // history of what was believed and when survives the correction.
    if (deltaCents > 0) {
      await tx.insert(ledgerEntries).values({
        bookingId,
        account: "refund",
        direction: "debit",
        amountCents: deltaCents,
        currency: charge.currency.toUpperCase(),
        status: "reversed",
        relatedStripeObjectId: charge.id,
      });
    }

    /*
     * The educator's accrual is reversed on a full refund, the same way a lost
     * dispute reverses it. Left `accrued`, a session whose money went back to the
     * parent stays eligible for a future payout selection.
     */
    if (fully) {
      await tx
        .update(ledgerEntries)
        .set({ status: "reversed" })
        .where(
          and(
            eq(ledgerEntries.bookingId, bookingId),
            eq(ledgerEntries.account, "educator_earnings_accrued"),
          ),
        );
    }

    return { disputed, deltaCents };
  });

  if (outcome.disputed) {
    logger.error(
      { bookingId, chargeId: charge.id, amountRefundedCents: refunded },
      "refund landed on a disputed booking — amounts recorded, status left disputed",
    );
  }

  recordAuditDetached({
    action: fully ? "booking.refunded" : "booking.partially_refunded",
    entityType: "booking",
    entityId: bookingId,
    after: {
      amountRefundedCents: refunded,
      refundedNowCents: outcome.deltaCents,
      chargeId: charge.id,
      leftDisputed: outcome.disputed,
    },
  });

  return true;
}

/**
 * A refund Stripe accepted and then couldn't complete — a closed account, a
 * rejected credit.
 *
 * The failure has to be undone in both directions. `refundBooking` advances
 * `amountRefundedCents` optimistically so a concurrent request can't refund past
 * the cap, and `charge.refunded` moved the booking to `refunded` — but no money
 * left. So the running total comes back down and the booking is returned to a
 * status that matches what actually happened, which is never `refunded`.
 *
 * A `disputed` booking is left alone, for the same reason as above.
 */
/**
 * Where a booking belongs once money stops being the thing that defines it — a
 * dispute resolved in our favour, or a refund the bank rejected.
 *
 * `completedAt` alone can't answer it: `recordBookingOutcome` stamps that column
 * for `no_show` as well as `completed`, so a booking restored from those two
 * columns would silently turn every no-show into a delivered session — and
 * `no_show` is the one that means the educator turned up and the learner didn't.
 * The audit row written when the outcome was recorded is append-only and is the
 * only surviving record of which one a coordinator chose, so it is what decides.
 */
async function deliveredStatus(
  tx: Tx,
  bookingId: string,
): Promise<"completed" | "no_show"> {
  const [recorded] = await tx
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityId, bookingId),
        eq(auditLog.action, "booking.outcome_recorded"),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  return (recorded?.after as { status?: string } | null)?.status === "no_show"
    ? "no_show"
    : "completed";
}

async function handleRefundFailed(
  refund: Stripe.Refund,
  ownership: Ownership,
): Promise<boolean> {
  if (!ownership.bookingId) return false;

  const bookingId = ownership.bookingId;

  const outcome = await db.transaction(async (tx) => {
    const [booking] = await tx
      .select({
        status: bookings.status,
        confirmedAt: bookings.confirmedAt,
        completedAt: bookings.completedAt,
      })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for("update")
      .limit(1);

    if (!booking) return null;

    const payment = await settledPaymentRow(tx, bookingId);
    if (!payment) return null;

    // `greatest` in SQL rather than arithmetic here: the figure this is undoing
    // may have been written by a request that raced this event.
    const [reverted] = await tx
      .update(payments)
      .set({
        amountRefundedCents: sql`greatest(0, ${payments.amountRefundedCents} - ${refund.amount})`,
      })
      .where(eq(payments.id, payment.id))
      .returning({ amountRefundedCents: payments.amountRefundedCents });

    const stillRefunded = reverted?.amountRefundedCents ?? 0;
    const fully = stillRefunded >= payment.amountReceivedCents;

    const paymentStatus = fully
      ? ("refunded" as const)
      : stillRefunded > 0
        ? ("partially_refunded" as const)
        : ("succeeded" as const);

    if (booking.status !== "disputed") {
      const bookingStatus = fully
        ? ("refunded" as const)
        : stillRefunded > 0
          ? ("partially_refunded" as const)
          : booking.completedAt
            ? await deliveredStatus(tx, bookingId)
            : booking.confirmedAt
              ? ("confirmed" as const)
              : ("paid_unconfirmed" as const);

      await tx
        .update(bookings)
        .set({ status: bookingStatus })
        .where(eq(bookings.id, bookingId));
      await tx
        .update(payments)
        .set({ status: paymentStatus })
        .where(eq(payments.id, payment.id));

      return { bookingStatus, amountRefundedCents: stillRefunded };
    }

    return { bookingStatus: booking.status, amountRefundedCents: stillRefunded };
  });

  if (!outcome) return false;

  /*
   * `error` and an audit row, because nothing else will notice: the parent has
   * already been emailed "refunded", and the money is still in the account.
   */
  logger.error(
    {
      bookingId,
      refundId: refund.id,
      status: refund.status,
      failureReason: refund.failure_reason,
      amountCents: refund.amount,
    },
    "refund failed after Stripe accepted it — the parent was told it was refunded",
  );

  recordAuditDetached({
    action: "booking.refund_reversed",
    entityType: "booking",
    entityId: bookingId,
    after: {
      refundId: refund.id,
      amountCents: refund.amount,
      failureReason: refund.failure_reason ?? null,
      restoredStatus: outcome.bookingStatus,
      amountRefundedCents: outcome.amountRefundedCents,
    },
  });

  return true;
}

/**
 * A dispute hard-locks the booking. No refund path may run while one is open —
 * refunding a disputed charge loses the money twice.
 *
 * **A dispute closed in our favour has to lift the lock**, because nothing else
 * on the platform ever clears `disputed`. Left set, the booking vanishes from the
 * educator's assignments (that filter excludes it), can't be confirmed, can't be
 * refunded, and the accrual stays `at_risk` where no payout will ever pick it up —
 * a permanent freeze as the reward for winning.
 *
 * The status to restore is *derived*, not stored: there is no column holding what
 * the booking was before, and adding one to record a state already implied by the
 * row would be a migration for nothing. The two facts that outlive a dispute are
 * what the payment shows was refunded and the booking's own confirm/complete
 * stamps, and between them they pin every reachable prior state.
 */
async function handleDispute(
  dispute: Stripe.Dispute,
  ownership: Ownership,
  closed: boolean,
): Promise<boolean> {
  if (!ownership.bookingId) return false;

  const bookingId = ownership.bookingId;
  const lost = closed && dispute.status === "lost";
  const won = closed && !lost;

  const restored = await db.transaction(async (tx) => {
    const [booking] = await tx
      .select({ confirmedAt: bookings.confirmedAt, completedAt: bookings.completedAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for("update")
      .limit(1);

    const payment = await settledPaymentRow(tx, bookingId);

    if (!won) {
      await tx
        .update(bookings)
        .set({ status: "disputed" })
        .where(eq(bookings.id, bookingId));

      /*
       * Booking-wide on purpose, unlike the per-attempt writes elsewhere: a
       * dispute is against the booking's money, and no attempt row on it may
       * look settled while the bank is deciding.
       */
      await tx
        .update(payments)
        .set({ status: "disputed" })
        .where(eq(payments.bookingId, bookingId));

      // The educator's accrual is at risk the moment a dispute opens, and reversed
      // if it's lost — otherwise a payout could be approved against money that has
      // already left the account.
      await tx
        .update(ledgerEntries)
        .set({ status: lost ? "reversed" : "at_risk" })
        .where(
          and(
            eq(ledgerEntries.bookingId, bookingId),
            eq(ledgerEntries.account, "educator_earnings_accrued"),
          ),
        );

      if (lost) {
        await tx.insert(ledgerEntries).values({
          bookingId,
          account: "dispute",
          direction: "debit",
          amountCents: dispute.amount,
          currency: dispute.currency.toUpperCase(),
          status: "reversed",
          relatedStripeObjectId: dispute.id,
        });
      }

      return null;
    }

    const received = payment?.amountReceivedCents ?? 0;
    const refunded = payment?.amountRefundedCents ?? 0;
    const fullyRefunded = received > 0 && refunded >= received;
    const partlyRefunded = refunded > 0 && !fullyRefunded;

    const bookingStatus = fullyRefunded
      ? ("refunded" as const)
      : partlyRefunded
        ? ("partially_refunded" as const)
        : booking?.completedAt
          ? await deliveredStatus(tx, bookingId)
          : booking?.confirmedAt
            ? ("confirmed" as const)
            : ("paid_unconfirmed" as const);

    const paymentStatus = fullyRefunded
      ? ("refunded" as const)
      : partlyRefunded
        ? ("partially_refunded" as const)
        : ("succeeded" as const);

    await tx.update(bookings).set({ status: bookingStatus }).where(eq(bookings.id, bookingId));

    await tx
      .update(payments)
      .set({ status: paymentStatus })
      .where(payment ? eq(payments.id, payment.id) : eq(payments.bookingId, bookingId));

    // Back to plain `accrued`: the money stayed, so the educator can be paid for
    // this session once the settlement window passes.
    await tx
      .update(ledgerEntries)
      .set({ status: "accrued" })
      .where(
        and(
          eq(ledgerEntries.bookingId, bookingId),
          eq(ledgerEntries.account, "educator_earnings_accrued"),
        ),
      );

    return { bookingStatus, paymentStatus };
  });

  recordAuditDetached({
    action: closed ? "booking.dispute_closed" : "booking.disputed",
    entityType: "booking",
    entityId: bookingId,
    after: {
      disputeId: dispute.id,
      status: dispute.status,
      amountCents: dispute.amount,
      lost,
      restoredStatus: restored?.bookingStatus ?? "disputed",
    },
  });

  return true;
}

/**
 * Records the PaymentIntent id a completed Checkout Session names.
 *
 * Ids only. It deliberately does **not** mark anything paid: a completed session
 * can still be unpaid (async methods, or `payment_status: unpaid`), and treating
 * completion as payment is the phantom-paid booking §8 forbids.
 *
 * The status is only ever advanced *out of a live state*. Stripe does not order
 * this event against `payment_intent.succeeded`, so a late arrival would
 * otherwise downgrade a `succeeded` row — which strands the refund path
 * permanently (`cannotConfirmBooking` and the SLA auto-refund both look for a
 * settled payment) and re-enters the row into the
 * `payments_one_live_per_booking` partial unique index.
 */
async function recordCheckoutSessionIds(session: Stripe.Checkout.Session): Promise<void> {
  const intentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  if (!intentId) return;

  await db
    .update(payments)
    .set({ stripePaymentIntentId: intentId })
    .where(eq(payments.stripeCheckoutSessionId, session.id));

  await db
    .update(payments)
    .set({ status: session.payment_status === "paid" ? "processing" : "requires_payment" })
    .where(
      and(
        eq(payments.stripeCheckoutSessionId, session.id),
        eq(payments.status, "requires_payment"),
      ),
    );
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

  const type = handledEventType(event.type);
  if (type === null) {
    logger.info({ type: event.type }, "unhandled stripe event type");
    await markProcessed(event.id, false);
    return false;
  }

  try {
    let handled = false;

    switch (type) {
      case "checkout.session.completed": {
        await recordCheckoutSessionIds(object as Stripe.Checkout.Session);
        handled = true;
        break;
      }

      case "checkout.session.async_payment_succeeded": {
        /*
         * Should be unreachable, and enforced rather than assumed: sessions are
         * created `payment_method_types: ["card"]`, so no delayed-notification
         * method can be chosen. If it ever fires, the ids are recorded and
         * nothing is marked paid — an async payment needs the verified-transition
         * path in `handlePaymentSucceeded` (amount check, booking lock, ledger),
         * not this branch, and allowing card-only to lapse silently is what would
         * make a paid async booking sit unpaid forever.
         */
        logger.error(
          { eventId: event.id },
          "async payment succeeded on a card-only checkout — recorded but NOT marked paid",
        );
        await recordCheckoutSessionIds(object as Stripe.Checkout.Session);
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

      case "refund.failed":
        handled = await handleRefundFailed(object as Stripe.Refund, ownership);
        break;

      case "refund.updated": {
        /*
         * `refund.updated` fires for every state change, most of them benign. Only
         * a refund that ended up not moving money needs undoing.
         */
        const refund = object as Stripe.Refund;
        handled =
          refund.status === "failed" || refund.status === "canceled"
            ? await handleRefundFailed(refund, ownership)
            : false;
        break;
      }

      case "charge.dispute.created":
        handled = await handleDispute(object as Stripe.Dispute, ownership, false);
        break;

      case "charge.dispute.closed":
        handled = await handleDispute(object as Stripe.Dispute, ownership, true);
        break;

      default: {
        // Unreachable: `handledEventType` above rejects anything not in
        // HANDLED_EVENT_TYPES, so adding an entry there without a case here is a
        // compile error rather than an event that quietly does nothing.
        const unreachable: never = type;
        throw new Error(`no handler for stripe event type ${String(unreachable)}`);
      }
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
