import { randomBytes } from "node:crypto";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type {
  BookingStatusResponse,
  CreateBookingRequest,
  CreateBookingResponse,
  ResumeCheckoutResponse,
} from "../contracts/bookings.ts";
import {
  CONSENT_TEXTS,
  CURRENT_BOOKING_GUARDIAN_CONSENT_VERSION,
  CURRENT_LEARNER_CONSENT_VERSION,
} from "../contracts/consent.ts";
import { FLAG_MESSAGES } from "../constants.ts";
import { db } from "../db/client.ts";
import {
  bookings,
  consentRecords,
  customerProfiles,
  educatorProfiles,
  learners,
  payments,
  users,
} from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { civilInstant, endOfCivilMonthsAhead } from "../lib/civil-time.ts";
import { encryptField } from "../lib/crypto-field.ts";
import { logger } from "../lib/logger.ts";
import { isUniqueViolation } from "../lib/pg-errors.ts";
import { sha256Hex } from "../lib/tokens.ts";
import {
  getStripe,
  idempotencyKey,
  projectMetadata,
  stripePublishableKey,
} from "../lib/stripe.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import {
  assertFlagEnabled,
  getEffectiveConfig,
  type EffectiveConfig,
} from "./config.service.ts";
import {
  assertTeachesTopic,
  priceSession,
  requireEducator,
  requireSubject,
} from "./quote.service.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/**
 * Booking creation and status.
 *
 * The flow, in the order the locked design requires (ARCHITECTURE.md §8):
 *
 * 1. Learner row and both consent records are written **before** any money moves.
 *    The COPPA basis rests on consent captured at the moment child data is first
 *    entered, and a $0 comp booking has no payment to attach it to — so consent
 *    can never be a side effect of checkout.
 * 2. The booking is **committed** as `pending_payment` before Stripe is called.
 *    Committing first means a PaymentIntent can never exist for a booking that
 *    isn't in our database; the reverse ordering produces exactly the orphan
 *    charge §8 then has to auto-refund.
 * 3. Only then is a Checkout Session created, priced from the server's own quote.
 *
 * Nothing here marks anything paid. That is the webhook's job and only the
 * webhook's — see `stripe-webhook.service.ts`.
 */

/** Unambiguous alphabet: no O/0, I/1, S/5 to misread over the phone. */
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXY2346789";

function bookingReference(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `YLJ-${out}`;
}

/** How many times a reference collision is worth retrying before it's a 500. */
const REFERENCE_ATTEMPTS = 3;

/**
 * Retries the whole booking transaction on a duplicate reference.
 *
 * A collision is about 1 in 29⁶, but the consequence is out of proportion to the
 * odds: a unique violation aborts the transaction, taking the learner row and
 * both consent records with it, and the parent sees a 500 for a name clash. It
 * has to be the whole transaction rather than just the insert — Postgres refuses
 * every further statement once one has failed inside it.
 */
async function withReferenceRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= REFERENCE_ATTEMPTS || !isUniqueViolation(error, "bookings_reference_key")) {
        throw error;
      }
      logger.warn({ tries }, "booking reference collided — retrying with a fresh one");
    }
  }
}

/**
 * Rejects a requested slot the platform can't actually take.
 *
 * The contract's `civilDateSchema` checks that the date exists; this checks
 * whether it is *bookable*, which is policy and so takes the notice and window rules
 * from site configuration. Both halves have to run here: without them
 * `preferredDate: "2026-13-45"` and a date in the past both validate, are charged, and
 * reach staff and educators as garbage. The browser's calendar enforcing the notice
 * rule is not enough, because a Server Action is a public endpoint.
 *
 * Compared as instants rather than strings, through `BOOKING_TIMEZONE`: "is this
 * a day away" is a question about time passing, and a civil string can't answer
 * it.
 */
function assertRequestableSlot(
  input: {
    preferredDate: string;
    preferredTime: string;
    alternateTime?: string;
  },
  policy: EffectiveConfig["booking"],
): void {
  const startsAt = civilInstant(input.preferredDate, input.preferredTime);

  if (!startsAt) {
    throw new AppError("validation_failed", "That isn't a date and time we can book.", {
      fieldErrors: { preferredDate: "Pick a real date for the session." },
    });
  }

  const earliest = Date.now() + policy.minNoticeHours * 3_600_000;
  const notice = `We need at least ${policy.minNoticeHours} hours' notice so a coordinator can reach the educator and confirm.`;

  if (startsAt.getTime() < earliest) {
    throw new AppError("validation_failed", notice, {
      fieldErrors: { preferredTime: "Choose a later time." },
    });
  }

  if (startsAt.getTime() > endOfCivilMonthsAhead(policy.windowMonths).getTime()) {
    throw new AppError(
      "validation_failed",
      "That's further ahead than we're taking bookings for. Please choose a nearer date.",
      { fieldErrors: { preferredDate: "Pick a date within the next couple of months." } },
    );
  }

  // The second choice is a time on the same requested date, so the notice rule
  // binds it too — an alternate inside the window isn't one we could offer.
  if (input.alternateTime) {
    const alternateAt = civilInstant(input.preferredDate, input.alternateTime);
    if (!alternateAt || alternateAt.getTime() < earliest) {
      throw new AppError("validation_failed", notice, {
        fieldErrors: { alternateTime: "Choose a later second choice." },
      });
    }
  }
}

/**
 * The parent's profile row, which is what owns a booking. Exported because the
 * quote route needs it too, and because "which profile is this session?" must
 * have exactly one answer.
 */
export async function requireCustomerProfile(userId: string) {
  const [profile] = await db
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    // A parent account always has one. Reaching here means an educator or staff
    // session got this far, which the route guard should already have refused.
    throw new AppError("forbidden", "Only a parent account can book a session.");
  }
  return profile;
}

/** Appends a consent record with the hash of the exact copy shown. */
async function writeConsent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    userId: string;
    consentType: "learner_data" | "signup_guardian";
    version: keyof typeof CONSENT_TEXTS;
    method: string;
    context: RequestContext;
  },
): Promise<void> {
  await tx.insert(consentRecords).values({
    userId: input.userId,
    consentType: input.consentType,
    textVersion: input.version,
    // The server hashes its own constant, never a string from the browser — a
    // client-supplied text would make the record prove nothing.
    textHash: sha256Hex(CONSENT_TEXTS[input.version]),
    method: input.method,
    ip: input.context.ip,
    userAgent: input.context.userAgent,
  });
}

export async function requireCustomerProfileId(userId: string): Promise<string> {
  return (await requireCustomerProfile(userId)).id;
}

export async function createBooking(
  input: CreateBookingRequest,
  principal: AuthenticatedPrincipal,
  context: RequestContext,
): Promise<CreateBookingResponse> {
  await assertFlagEnabled("bookingsEnabled", FLAG_MESSAGES.bookingsPaused);

  const profile = await requireCustomerProfile(principal.userId);
  const config = await getEffectiveConfig();

  // Before anything is written and long before anything is charged: an
  // unbookable slot is a validation failure, not a booking to clean up later.
  assertRequestableSlot(input, config.booking);

  const educator = await requireEducator(db, input.educatorSlug);
  const subject = await requireSubject(db, input.subjectSlug);
  assertTeachesTopic(educator, input.subjectTopic);

  /*
   * Priced here, server-side, from the rate tables — not read back from a quote
   * the client handed us. `quoteId` exists in the contract so a future flow can
   * pin a displayed price, but the amount charged is always what this call
   * computes now.
   */
  const priced = await priceSession(db, {
    educatorProfileId: educator.id,
    subjectId: subject.id,
    subjectTopic: input.subjectTopic,
    format: input.format,
    durationMinutes: input.durationMinutes,
  });

  const slaDeadline = new Date(
    Date.now() + config.booking.confirmationSlaDays * 24 * 60 * 60 * 1000,
  );

  const created = await withReferenceRetry(() => db.transaction(async (tx) => {
    const [learner] = await tx
      .insert(learners)
      .values({
        customerProfileId: profile.id,
        firstNameEncrypted: encryptField(input.learner.firstName),
        ageBand: input.learner.ageBand,
        focusEncrypted: input.learner.focus ? encryptField(input.learner.focus) : null,
      })
      .returning({ id: learners.id });

    // Both consents, in the same transaction as the child data they cover. A
    // learner row that exists without its consent record is the one state this
    // must never reach.
    await writeConsent(tx, {
      userId: principal.userId,
      consentType: "learner_data",
      version: CURRENT_LEARNER_CONSENT_VERSION,
      method: "checkbox:booking-form",
      context,
    });
    await writeConsent(tx, {
      userId: principal.userId,
      consentType: "signup_guardian",
      version: CURRENT_BOOKING_GUARDIAN_CONSENT_VERSION,
      method: "checkbox:booking-form",
      context,
    });

    const [booking] = await tx
      .insert(bookings)
      .values({
        reference: bookingReference(),
        customerProfileId: profile.id,
        learnerId: learner!.id,
        educatorProfileId: educator.id,
        subjectId: subject.id,
        subjectTopic: input.subjectTopic,
        format: input.format,
        durationMinutes: input.durationMinutes,
        preferredDate: input.preferredDate,
        preferredTime: input.preferredTime,
        alternateTime: input.alternateTime ?? null,
        flexibleTime: input.flexibleTime,
        addressEncrypted: input.address
          ? encryptField(JSON.stringify(input.address))
          : null,
        status: "pending_payment",
        currency: priced.currency,
        frozenQuote: {
          lineItems: priced.lineItems,
          totalCents: priced.totalCents,
          effectiveRatePerHourCents: priced.effectiveRatePerHourCents,
          computedAt: new Date().toISOString(),
        },
        totalCents: priced.totalCents,
        takeRateBpsSnapshot: priced.takeRateBps,
        educatorEarningsCents: priced.educatorEarningsCents,
        platformMarginCents: priced.platformMarginCents,
        slaDeadline,
      })
      .returning({ id: bookings.id, reference: bookings.reference });

    await recordAudit(tx, {
      actorId: principal.userId,
      actorRole: principal.activeRole,
      action: "booking.created",
      entityType: "booking",
      entityId: booking!.id,
      after: {
        reference: booking!.reference,
        educator: educator.slug,
        subject: subject.slug,
        totalCents: priced.totalCents,
        status: "pending_payment",
      },
      ip: context.ip,
      requestId: context.requestId,
    });

    return { id: booking!.id, reference: booking!.reference, learnerId: learner!.id };
  }));

  /*
   * Stripe comes after the commit. If this throws, the parent sees an error and
   * has a `pending_payment` booking with no charge — recoverable through
   * `resumeBookingCheckout`, and invisible to them. The opposite ordering leaves a
   * charge with no booking, which is real money and a manual refund.
   */
  const session = await openCheckoutSession({
    bookingId: created.id,
    reference: created.reference,
    currency: priced.currency,
    totalCents: priced.totalCents,
    durationMinutes: input.durationMinutes,
    subjectTopic: input.subjectTopic,
    educatorName: educator.name,
    customerEmail: input.contact.email,
    attempt: 0,
  });

  await db.insert(payments).values({
    bookingId: created.id,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: session.paymentIntentId,
    status: "requires_payment",
    currency: priced.currency,
    amountCents: priced.totalCents,
  });

  return {
    bookingId: created.id,
    reference: created.reference,
    status: "pending_payment",
    quote: {
      id: created.id,
      currency: priced.currency,
      lineItems: priced.lineItems,
      totalCents: priced.totalCents,
      expiresAt: new Date(
        Date.now() + config.booking.quoteTtlMinutes * 60_000,
      ).toISOString(),
    },
    checkoutClientSecret: session.clientSecret,
    checkoutExpiresAt: session.expiresAt,
    publishableKey: stripePublishableKey(),
  };
}

/** A Checkout Session the browser can actually mount. */
interface OpenCheckoutSession {
  id: string;
  clientSecret: string;
  paymentIntentId: string | null;
  /** Stripe's own deadline for this session, not one derived from our clock. */
  expiresAt: string;
}

/**
 * Opens an embedded Checkout Session for a booking that is already committed.
 *
 * Shared by `createBooking` and `resumeBookingCheckout` so the two cannot
 * disagree about the metadata, the capture mode, or the payment methods. The
 * metadata in particular is not cosmetic: an untagged Session is invisible to the
 * webhook's ownership filter, and a Session without `booking_id` produces events
 * that resolve to nothing.
 */
async function openCheckoutSession(input: {
  bookingId: string;
  reference: string;
  currency: string;
  totalCents: number;
  durationMinutes: number;
  subjectTopic: string;
  educatorName: string;
  customerEmail: string;
  /** Which attempt this is, so a fresh session gets a fresh idempotency key. */
  attempt: number;
}): Promise<OpenCheckoutSession> {
  const metadata = projectMetadata({
    booking_id: input.bookingId,
    booking_reference: input.reference,
  });

  /*
   * Read here rather than passed in, so `createBooking` and
   * `resumeBookingCheckout` cannot open sessions under different rules — the
   * description below is a promise printed on a Stripe receipt, and the two
   * paths saying different numbers of days is exactly the drift this function
   * exists to prevent.
   */
  const { booking: policy } = await getEffectiveConfig();

  const session = await getStripe().checkout.sessions.create(
    {
      mode: "payment",
      ui_mode: "embedded_page",
      /*
       * The parent stays on our page: we show our own confirmation, with the
       * coordinator-confirms timeline, rather than bouncing through Stripe's.
       * Completion is reported to the browser by Checkout and *verified* by us
       * against the booking's own status, which only the webhook can change.
       */
      redirect_on_completion: "never",
      currency: input.currency.toLowerCase(),
      customer_email: input.customerEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.totalCents,
            product_data: {
              name: `${input.durationMinutes}-minute session · ${input.subjectTopic}`,
              description: `Requested with ${input.educatorName}. A coordinator confirms your time within ${policy.confirmationSlaDays} days, or you're refunded in full.`,
            },
          },
        },
      ],
      /*
       * Tagged on the Session *and* on the PaymentIntent. Both, because the
       * webhook filter reads whichever object an event carries, and a
       * `payment_intent.*` event never sees the Session's metadata.
       *
       * `booking_id` is what makes an event resolvable back to a local row; the
       * `project` tag is what stops us acting on a sibling project's events. See
       * `lib/stripe.ts` for why that matters on a shared account.
       */
      metadata,
      payment_intent_data: {
        metadata,
        description: `${input.reference} · ${input.subjectTopic} with ${input.educatorName}`,
      },
      /*
       * Instant capture, per the locked decision. Authorize-then-capture is the
       * documented alternative and carries a ~7-day expiry SLA that would need its
       * own alarm and a `capture_failed` transition — not a costless toggle.
       *
       * Card-only, which the webhook relies on: the async-payment branches there
       * record ids without marking anything paid, and that is only safe while no
       * delayed-notification method can be chosen here.
       */
      payment_method_types: ["card"],
      expires_at:
        Math.floor(Date.now() / 1000) + policy.checkoutWindowMinutes * 60,
    },
    {
      /*
       * Deterministic. A retry after a timeout — where we never learned whether
       * Stripe created the session — reuses this key and returns the same session
       * rather than minting a second intent for the same booking. The attempt
       * number is what lets a *deliberate* second session exist.
       */
      idempotencyKey: idempotencyKey("booking", input.bookingId, "checkout", input.attempt),
    },
  );

  if (!session.client_secret) {
    throw new AppError("internal_error", "We couldn't start the payment. Please try again.", {
      logContext: { bookingId: input.bookingId, sessionId: session.id },
    });
  }

  return {
    id: session.id,
    clientSecret: session.client_secret,
    paymentIntentId:
      typeof session.payment_intent === "string" ? session.payment_intent : null,
    expiresAt: new Date(session.expires_at * 1000).toISOString(),
  };
}

/**
 * Hands back a client secret for a booking abandoned at the payment step.
 *
 * A `pending_payment` booking was otherwise unreachable: the client secret is
 * returned once, by `POST /bookings`, and a closed tab loses it. Starting over
 * costs the parent a second learner row and a second consent pair, and a parent
 * who keeps trying hits the 10-per-hour booking limit on a booking they are
 * trying to *pay* for.
 *
 * The live session is reused when Stripe still has it open, which is what keeps
 * the double-charge guarantee: the `payments_one_live_per_booking` index allows a
 * single live attempt, so a fresh session retires the abandoned row before its
 * own lands. No quote is re-issued and no amount is accepted — the charge is the
 * booking's own frozen `totalCents`.
 */
export async function resumeBookingCheckout(
  bookingId: string,
  principal: AuthenticatedPrincipal,
): Promise<ResumeCheckoutResponse> {
  const profile = await requireCustomerProfile(principal.userId);

  const [booking] = await db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      currency: bookings.currency,
      totalCents: bookings.totalCents,
      durationMinutes: bookings.durationMinutes,
      subjectTopic: bookings.subjectTopic,
      customerProfileId: bookings.customerProfileId,
      educatorName: educatorProfiles.name,
      parentEmail: users.email,
    })
    .from(bookings)
    .innerJoin(educatorProfiles, eq(bookings.educatorProfileId, educatorProfiles.id))
    .innerJoin(customerProfiles, eq(bookings.customerProfileId, customerProfiles.id))
    .innerJoin(users, eq(customerProfiles.userId, users.id))
    .where(eq(bookings.id, bookingId))
    .limit(1);

  // Not found and not-yours answer identically, so this can't be used to probe
  // which booking ids exist.
  if (!booking || booking.customerProfileId !== profile.id) {
    throw new AppError("not_found", "We couldn't find that booking.");
  }

  if (booking.status !== "pending_payment") {
    throw new AppError(
      "conflict",
      "That booking isn't waiting on payment, so there's nothing to pay for here.",
    );
  }

  const response = {
    bookingId: booking.id,
    reference: booking.reference,
    totalCents: booking.totalCents,
    currency: booking.currency,
    publishableKey: stripePublishableKey(),
  };

  const attempts = await db
    .select({
      id: payments.id,
      status: payments.status,
      stripeCheckoutSessionId: payments.stripeCheckoutSessionId,
    })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), isNotNull(payments.stripeCheckoutSessionId)))
    .orderBy(desc(payments.createdAt));

  const newest = attempts[0];

  if (newest?.stripeCheckoutSessionId) {
    /*
     * Stripe is asked rather than trusted from our own row: a session expires on
     * its own 30-minute clock, and `checkout.session.expired` may not have landed
     * yet. A failed lookup is not fatal — it just means a fresh session.
     */
    try {
      const existing = await getStripe().checkout.sessions.retrieve(
        newest.stripeCheckoutSessionId,
      );
      if (existing.status === "open" && existing.client_secret) {
        return {
          ...response,
          checkoutClientSecret: existing.client_secret,
          checkoutExpiresAt: new Date(existing.expires_at * 1000).toISOString(),
        };
      }
    } catch (error) {
      logger.warn(
        { bookingId, sessionId: newest.stripeCheckoutSessionId, err: error },
        "could not read the existing checkout session — opening a new one",
      );
    }
  }

  const session = await openCheckoutSession({
    bookingId: booking.id,
    reference: booking.reference,
    currency: booking.currency,
    totalCents: booking.totalCents,
    durationMinutes: booking.durationMinutes,
    subjectTopic: booking.subjectTopic,
    educatorName: booking.educatorName,
    customerEmail: booking.parentEmail,
    // One row per attempt, so the count is the attempt number — and two
    // concurrent resumes compute the same one, reuse the same idempotency key,
    // and get the same session back rather than two.
    attempt: attempts.length,
  });

  try {
    await db.transaction(async (tx) => {
      // The abandoned attempt is retired first: `payments_one_live_per_booking`
      // permits exactly one live row, which is the double-charge guard.
      await tx
        .update(payments)
        .set({ status: "canceled" })
        .where(
          and(
            eq(payments.bookingId, bookingId),
            inArray(payments.status, ["requires_payment", "processing"]),
          ),
        );

      await tx.insert(payments).values({
        bookingId,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.paymentIntentId,
        status: "requires_payment",
        currency: booking.currency,
        amountCents: booking.totalCents,
      });
    });
  } catch (error) {
    // Two resumes raced, shared the idempotency key, and were handed the same
    // session — the other request recorded it, which is the right outcome. The
    // client secret below is the same one either way.
    if (!isUniqueViolation(error, "payments_checkout_session_key")) throw error;
  }

  return {
    ...response,
    checkoutClientSecret: session.clientSecret,
    checkoutExpiresAt: session.expiresAt,
  };
}

/**
 * The booking's own view of itself, for the page polling after checkout.
 *
 * `paymentPending` is the honest middle state: Stripe has the money and our
 * webhook hasn't landed. Reporting `paid_unconfirmed` early — on the browser's
 * word that Checkout finished — is exactly the phantom-paid booking §8 forbids.
 */
export async function getBookingStatus(
  bookingId: string,
  principal: AuthenticatedPrincipal,
): Promise<BookingStatusResponse> {
  const profile = await requireCustomerProfile(principal.userId);

  const [booking] = await db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      totalCents: bookings.totalCents,
      currency: bookings.currency,
      slaDeadline: bookings.slaDeadline,
      customerProfileId: bookings.customerProfileId,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  // Not found and not-yours answer identically, so this can't be used to probe
  // which booking ids exist.
  if (!booking || booking.customerProfileId !== profile.id) {
    throw new AppError("not_found", "We couldn't find that booking.");
  }

  /*
   * The live attempt, identified by status rather than by "has no charge id yet".
   * A row gets its charge id at the moment it becomes authoritative, so
   * `isNull(stripeChargeId)` excluded exactly the row worth reading — and with no
   * `ORDER BY` before `limit(1)`, a booking with an earlier abandoned attempt
   * answered from whichever row Postgres happened to return.
   */
  const [payment] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(
      and(
        eq(payments.bookingId, booking.id),
        inArray(payments.status, ["requires_payment", "processing"]),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);

  return {
    bookingId: booking.id,
    reference: booking.reference,
    status: booking.status,
    paymentPending:
      booking.status === "pending_payment" &&
      (payment?.status === "requires_payment" || payment?.status === "processing"),
    totalCents: booking.totalCents,
    currency: booking.currency,
    slaDeadline: booking.slaDeadline?.toISOString() ?? null,
  };
}
