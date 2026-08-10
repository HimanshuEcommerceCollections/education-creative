import { randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type {
  BookingStatusResponse,
  CreateBookingRequest,
  CreateBookingResponse,
} from "../contracts/bookings.ts";
import {
  CONSENT_TEXTS,
  CURRENT_BOOKING_GUARDIAN_CONSENT_VERSION,
  CURRENT_LEARNER_CONSENT_VERSION,
} from "../contracts/consent.ts";
import { BOOKING_POLICY } from "../constants.ts";
import { db } from "../db/client.ts";
import {
  bookings,
  consentRecords,
  customerProfiles,
  learners,
  payments,
} from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { encryptField } from "../lib/crypto-field.ts";
import { sha256Hex } from "../lib/tokens.ts";
import {
  getStripe,
  idempotencyKey,
  projectMetadata,
  stripePublishableKey,
} from "../lib/stripe.ts";
import { env } from "../env.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
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
  const profile = await requireCustomerProfile(principal.userId);

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
    Date.now() + BOOKING_POLICY.confirmationSlaDays * 24 * 60 * 60 * 1000,
  );

  const created = await db.transaction(async (tx) => {
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
  });

  /*
   * Stripe comes after the commit. If this throws, the parent sees an error and
   * has a `pending_payment` booking with no charge — recoverable, and invisible to
   * them. The opposite ordering leaves a charge with no booking, which is real
   * money and a manual refund.
   */
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      ui_mode: "embedded",
      /*
       * The parent stays on our page: we show our own confirmation, with the
       * coordinator-confirms timeline, rather than bouncing through Stripe's.
       * Completion is reported to the browser by Checkout and *verified* by us
       * against the booking's own status, which only the webhook can change.
       */
      redirect_on_completion: "never",
      currency: priced.currency.toLowerCase(),
      customer_email: input.contact.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: priced.currency.toLowerCase(),
            unit_amount: priced.totalCents,
            product_data: {
              name: `${input.durationMinutes}-minute session · ${input.subjectTopic}`,
              description: `Requested with ${educator.name}. A coordinator confirms your time within ${BOOKING_POLICY.confirmationSlaDays} days, or you're refunded in full.`,
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
      metadata: projectMetadata({
        booking_id: created.id,
        booking_reference: created.reference,
      }),
      payment_intent_data: {
        metadata: projectMetadata({
          booking_id: created.id,
          booking_reference: created.reference,
        }),
        description: `${created.reference} · ${input.subjectTopic} with ${educator.name}`,
      },
      /*
       * Instant capture, per the locked decision. Authorize-then-capture is the
       * documented alternative and carries a ~7-day expiry SLA that would need its
       * own alarm and a `capture_failed` transition — not a costless toggle.
       */
      payment_method_types: ["card"],
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    },
    {
      /*
       * Deterministic. A retry after a timeout — where we never learned whether
       * Stripe created the session — reuses this key and returns the same session
       * rather than minting a second intent for the same booking.
       */
      idempotencyKey: idempotencyKey("booking", created.id, "checkout"),
    },
  );

  if (!session.client_secret) {
    throw new AppError("internal_error", "We couldn't start the payment. Please try again.", {
      logContext: { bookingId: created.id, sessionId: session.id },
    });
  }

  await db.insert(payments).values({
    bookingId: created.id,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId:
      typeof session.payment_intent === "string" ? session.payment_intent : null,
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
      expiresAt: new Date(Date.now() + BOOKING_POLICY.quoteTtlMinutes * 60_000).toISOString(),
    },
    checkoutClientSecret: session.client_secret,
    publishableKey: stripePublishableKey(),
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

  const [payment] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(and(eq(payments.bookingId, booking.id), isNull(payments.stripeChargeId)))
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

/** Whether payments are configured at all, for the client's feature gate. */
export function paymentsConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}
