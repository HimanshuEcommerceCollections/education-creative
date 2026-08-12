import { and, asc, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import type { UserRole } from "../contracts/roles.ts";
import type {
  AssignableEducator,
  BookingChildDetails,
  BookingStatus,
  CannotConfirmBookingRequest,
  ConfirmBookingRequest,
  CoordinatorBooking,
  EducatorAssignment,
  ParentBooking,
  RefundBookingRequest,
} from "../contracts/bookings.ts";
import { REFUND_POLICY } from "../contracts/bookings.ts";
import { db, type DbOrTx } from "../db/client.ts";
import {
  bookings,
  customerProfiles,
  educatorProfiles,
  learners,
  payments,
  subjects,
  users,
} from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { decryptField } from "../lib/crypto-field.ts";
import { logger } from "../lib/logger.ts";
import { getStripe, idempotencyKey } from "../lib/stripe.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import { trySend } from "./email/index.ts";
import {
  bookingAssignedTemplate,
  bookingConfirmedTemplate,
  bookingCouldNotConfirmTemplate,
  bookingRefundedTemplate,
} from "./email/templates.ts";
import { requireCustomerProfile } from "./booking.service.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/**
 * The confirm-later half of a booking (ARCHITECTURE.md §8, r3).
 *
 * `booking.service.ts` takes the money; this decides what happens to it. A paid
 * booking sits in `paid_unconfirmed` until a coordinator — who has phoned the
 * educator, because nothing on this platform reserves a slot — either assigns
 * that one educator and confirms, or can't fulfil it and refunds in full.
 *
 * Three rules hold everywhere below:
 *
 * 1. **Every transition takes the booking row `FOR UPDATE` first.** Confirm,
 *    can't-confirm and the SLA sweep all race each other and the webhook; the
 *    lock plus a status re-check inside the transaction is what stops a booking
 *    being confirmed and refunded at once.
 * 2. **Child data is never in a list.** Learner names and addresses come only
 *    from `getBookingChildDetails`, which writes an audit row per access.
 * 3. **A confirm names an `approved` educator or it fails.** That is the
 *    child-safety invariant, enforced here rather than in any UI.
 */

/**
 * Who is making a transition.
 *
 * Nullable rather than `AuthenticatedPrincipal` because the SLA sweep has no
 * person behind it, and `audit_log.actor_id` is already nullable for exactly
 * that case. Borrowing an admin's identity for a timer would put their name on a
 * refund they never issued.
 */
export interface BookingActor {
  userId: string | null;
  activeRole: UserRole | null;
}

/** The sweep's actor: a refund the clock issued, attributable to no person. */
const SYSTEM_ACTOR: BookingActor = { userId: null, activeRole: null };

/**
 * The receipt breakdown out of the frozen quote.
 *
 * `frozen_quote` is deliberately a JSON snapshot (§8) rather than a join across
 * effective-dated pricing, so reading it back is a cast — the shape is whatever
 * was true when the booking was priced, and nothing may recompute it now.
 */
function frozenLineItems(frozenQuote: unknown): { label: string; amountCents: number }[] {
  const quote = frozenQuote as
    | { lineItems?: { label: string; amountCents: number }[] }
    | null;
  return quote?.lineItems ?? [];
}

/**
 * The staff queue. Defaults to the bookings that need a decision, oldest SLA
 * deadline first — the order a coordinator should work them in, since that is
 * the one that runs out of time first.
 */
export async function listBookingQueue(options: {
  statuses?: readonly BookingStatus[];
  limit: number;
}): Promise<CoordinatorBooking[]> {
  const statuses = options.statuses ?? (["paid_unconfirmed"] as const);

  const rows = await db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      requestedSlug: educatorProfiles.slug,
      requestedName: educatorProfiles.name,
      assignedEducatorId: bookings.assignedEducatorId,
      parentName: users.fullName,
      parentEmail: users.email,
      parentPhone: users.phone,
      learnerAgeBand: learners.ageBand,
      subjectTopic: bookings.subjectTopic,
      subjectId: bookings.subjectId,
      format: bookings.format,
      durationMinutes: bookings.durationMinutes,
      preferredDate: bookings.preferredDate,
      preferredTime: bookings.preferredTime,
      alternateTime: bookings.alternateTime,
      flexibleTime: bookings.flexibleTime,
      currency: bookings.currency,
      totalCents: bookings.totalCents,
      educatorEarningsCents: bookings.educatorEarningsCents,
      platformMarginCents: bookings.platformMarginCents,
      frozenQuote: bookings.frozenQuote,
      slaDeadline: bookings.slaDeadline,
      createdAt: bookings.createdAt,
      confirmedAt: bookings.confirmedAt,
      cancelledAt: bookings.cancelledAt,
    })
    .from(bookings)
    .innerJoin(educatorProfiles, eq(bookings.educatorProfileId, educatorProfiles.id))
    .innerJoin(learners, eq(bookings.learnerId, learners.id))
    .innerJoin(customerProfiles, eq(bookings.customerProfileId, customerProfiles.id))
    .innerJoin(users, eq(customerProfiles.userId, users.id))
    .where(inArray(bookings.status, [...statuses]))
    .orderBy(asc(bookings.slaDeadline))
    .limit(options.limit);

  if (rows.length === 0) return [];

  /*
   * The assigned educator and the refund total are fetched separately rather than
   * as two more joins: a second join on `educator_profiles` needs an alias, and a
   * join on `payments` would multiply rows per attempt. Two small keyed lookups
   * are simpler to read and cheaper to be right about.
   */
  const assignedIds = rows
    .map((row) => row.assignedEducatorId)
    .filter((id): id is string => id !== null);

  const assignedById = new Map<string, { slug: string; name: string }>();
  if (assignedIds.length > 0) {
    const assignedRows = await db
      .select({ id: educatorProfiles.id, slug: educatorProfiles.slug, name: educatorProfiles.name })
      .from(educatorProfiles)
      .where(inArray(educatorProfiles.id, assignedIds));
    for (const row of assignedRows) {
      assignedById.set(row.id, { slug: row.slug, name: row.name });
    }
  }

  const paidByBooking = await paymentTotals(rows.map((row) => row.id));
  const subjectSlugs = await subjectSlugsById(rows.map((row) => row.subjectId));

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    requestedEducator: { slug: row.requestedSlug, name: row.requestedName },
    assignedEducator: row.assignedEducatorId
      ? assignedById.get(row.assignedEducatorId) ?? null
      : null,
    parentName: row.parentName,
    parentEmail: row.parentEmail,
    parentPhone: row.parentPhone,
    learnerAgeBand: row.learnerAgeBand,
    subjectSlug: subjectSlugs.get(row.subjectId) ?? "",
    subjectTopic: row.subjectTopic,
    format: row.format,
    durationMinutes: row.durationMinutes,
    preferredDate: row.preferredDate,
    preferredTime: row.preferredTime,
    alternateTime: row.alternateTime,
    flexibleTime: row.flexibleTime,
    currency: row.currency,
    totalCents: row.totalCents,
    educatorEarningsCents: row.educatorEarningsCents,
    platformMarginCents: row.platformMarginCents,
    amountRefundedCents: paidByBooking.get(row.id)?.refundedCents ?? 0,
    refundableCents: Math.max(
      0,
      (paidByBooking.get(row.id)?.receivedCents ?? 0) -
        (paidByBooking.get(row.id)?.refundedCents ?? 0),
    ),
    lineItems: frozenLineItems(row.frozenQuote),
    slaDeadline: row.slaDeadline.toISOString(),
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  }));
}

/**
 * The educators a coordinator may assign — `approved` only, so the picker can't
 * offer someone the child-safety invariant will refuse. The invariant is still
 * re-checked on confirm: this list is a convenience, not the enforcement.
 */
export async function listAssignableEducators(): Promise<AssignableEducator[]> {
  const rows = await db
    .select({
      slug: educatorProfiles.slug,
      name: educatorProfiles.name,
      subjects: educatorProfiles.subjects,
    })
    .from(educatorProfiles)
    .where(
      and(
        eq(educatorProfiles.verificationStatus, "approved"),
        isNull(educatorProfiles.deletedAt),
      ),
    )
    .orderBy(asc(educatorProfiles.name));

  return rows.map((row) => ({ slug: row.slug, name: row.name, subjects: row.subjects }));
}

/**
 * Settled and refunded totals per booking, summed across payment attempts.
 *
 * Both come from `payments` rather than the booking's `totalCents`: the quoted
 * total is what we asked for, and only what actually settled can be given back.
 */
async function paymentTotals(
  bookingIds: string[],
): Promise<Map<string, { receivedCents: number; refundedCents: number }>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db
    .select({
      bookingId: payments.bookingId,
      amountReceivedCents: payments.amountReceivedCents,
      amountRefundedCents: payments.amountRefundedCents,
    })
    .from(payments)
    .where(inArray(payments.bookingId, bookingIds));

  const totals = new Map<string, { receivedCents: number; refundedCents: number }>();
  for (const row of rows) {
    const running = totals.get(row.bookingId) ?? { receivedCents: 0, refundedCents: 0 };
    running.receivedCents += row.amountReceivedCents;
    running.refundedCents += row.amountRefundedCents;
    totals.set(row.bookingId, running);
  }
  return totals;
}

async function subjectSlugsById(subjectIds: string[]): Promise<Map<string, string>> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db
    .select({ id: subjects.id, slug: subjects.slug })
    .from(subjects)
    .where(inArray(subjects.id, subjectIds));
  return new Map(rows.map((row) => [row.id, row.slug]));
}

// ---------------------------------------------------------------------------
// Child data — one audited request at a time
// ---------------------------------------------------------------------------

/**
 * The learner's first name, focus note, and the in-home address.
 *
 * Staff may read any booking's; an educator may read only a booking that is
 * `confirmed` **and** assigned to them **and** whose assignment they are still
 * approved for. Every successful read writes `booking.child_data_accessed` —
 * §5 requires child-data access to be attributable to a person, and this is the
 * only door the plaintext comes through.
 */
export async function getBookingChildDetails(
  bookingId: string,
  principal: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<BookingChildDetails> {
  const [row] = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      format: bookings.format,
      assignedEducatorId: bookings.assignedEducatorId,
      addressEncrypted: bookings.addressEncrypted,
      firstNameEncrypted: learners.firstNameEncrypted,
      focusEncrypted: learners.focusEncrypted,
      ageBand: learners.ageBand,
    })
    .from(bookings)
    .innerJoin(learners, eq(bookings.learnerId, learners.id))
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!row) throw new AppError("not_found", "We couldn't find that booking.");

  if (!principal.isStaff) {
    const profile = await educatorProfileForUser(principal.userId);
    // Same reasoning as the assignment list: a partial refund leaves the session
    // on, so it must not take the address away from the person teaching it.
    const isTheirs =
      profile !== null &&
      row.assignedEducatorId === profile.id &&
      (row.status === "confirmed" || row.status === "partially_refunded");

    // Not-yours and not-found answer identically: an educator must not be able
    // to probe which bookings exist by watching the error change.
    if (!isTheirs) throw new AppError("not_found", "We couldn't find that booking.");
    if (profile.verificationStatus !== "approved") {
      throw new AppError(
        "forbidden",
        "Your background check needs to be current before learner details are shared.",
      );
    }
  }

  const details: BookingChildDetails = {
    bookingId: row.id,
    learnerFirstName: decryptField(row.firstNameEncrypted),
    learnerAgeBand: row.ageBand,
    learnerFocus: row.focusEncrypted ? decryptField(row.focusEncrypted) : null,
    address:
      row.addressEncrypted && row.format === "in_home"
        ? (JSON.parse(decryptField(row.addressEncrypted)) as BookingChildDetails["address"])
        : null,
  };

  await recordAudit(db, {
    actorId: principal.userId,
    actorRole: principal.activeRole,
    action: "booking.child_data_accessed",
    entityType: "booking",
    entityId: row.id,
    after: { fields: details.address ? ["learner", "address"] : ["learner"] },
    ip: ctx.ip,
    requestId: ctx.requestId,
  });

  return details;
}

async function educatorProfileForUser(userId: string) {
  const [profile] = await db
    .select({
      id: educatorProfiles.id,
      slug: educatorProfiles.slug,
      name: educatorProfiles.name,
      verificationStatus: educatorProfiles.verificationStatus,
    })
    .from(educatorProfiles)
    .where(and(eq(educatorProfiles.userId, userId), isNull(educatorProfiles.deletedAt)))
    .limit(1);
  return profile ?? null;
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/**
 * Assigns one educator and confirms the booking.
 *
 * Only from `paid_unconfirmed`: confirming an unpaid booking would promise a
 * session nobody has paid for, and re-confirming a confirmed one is a
 * reassignment, which is a separate deliberate act. The status is re-read under
 * `FOR UPDATE` inside the transaction, so a coordinator clicking Confirm while
 * the SLA sweep refunds the same row loses the race cleanly instead of both
 * winning.
 */
export async function confirmBooking(
  bookingId: string,
  input: ConfirmBookingRequest,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ reference: string; educatorName: string }> {
  const educator = await requireApprovedEducator(input.educatorSlug);

  const result = await db.transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);

    if (booking.status !== "paid_unconfirmed") {
      throw new AppError(
        "conflict",
        `That booking is ${STATUS_WORDS[booking.status]}, so it can't be confirmed now.`,
      );
    }

    const confirmedAt = new Date();
    await tx
      .update(bookings)
      .set({
        status: "confirmed",
        assignedEducatorId: educator.id,
        coordinatorId: actor.userId,
        confirmedAt,
      })
      .where(eq(bookings.id, bookingId));

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "booking.confirmed",
      entityType: "booking",
      entityId: bookingId,
      before: { status: booking.status, assignedEducatorId: booking.assignedEducatorId },
      after: {
        status: "confirmed",
        assignedEducator: educator.slug,
        requestedEducator: booking.requestedEducatorSlug,
        substituted: educator.id !== booking.educatorProfileId,
        note: input.note ?? null,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { booking, confirmedAt };
  });

  const when = `${result.booking.preferredDate} at ${result.booking.preferredTime}`;

  // Outside the transaction, and never fatal: the booking is confirmed either
  // way, and a mail outage must not roll back a session the parent is expecting.
  await trySend(
    {
      ...bookingConfirmedTemplate({
        parentName: result.booking.parentName,
        reference: result.booking.reference,
        educatorName: educator.name,
        when,
        substituted: educator.id !== result.booking.educatorProfileId,
      }),
      to: result.booking.parentEmail,
    },
    { purpose: "booking_confirmed", userId: result.booking.parentUserId },
  );

  if (educator.email) {
    await trySend(
      {
        ...bookingAssignedTemplate({
          educatorName: educator.name,
          reference: result.booking.reference,
          when,
          subjectTopic: result.booking.subjectTopic,
          format: result.booking.format,
        }),
        to: educator.email,
      },
      { purpose: "booking_assigned", userId: educator.userId ?? undefined },
    );
  }

  return { reference: result.booking.reference, educatorName: educator.name };
}

/**
 * The educator a confirm may name: listed, not deleted, and **approved**. The
 * approval check is the child-safety invariant (§5) — a confirm naming anyone
 * else is refused here, whoever calls it and whatever the UI offered.
 */
async function requireApprovedEducator(slug: string) {
  const [educator] = await db
    .select({
      id: educatorProfiles.id,
      slug: educatorProfiles.slug,
      name: educatorProfiles.name,
      userId: educatorProfiles.userId,
      verificationStatus: educatorProfiles.verificationStatus,
      email: users.email,
    })
    .from(educatorProfiles)
    .leftJoin(users, eq(educatorProfiles.userId, users.id))
    .where(and(eq(educatorProfiles.slug, slug), isNull(educatorProfiles.deletedAt)))
    .limit(1);

  if (!educator) throw new AppError("not_found", "No such educator.");

  if (educator.verificationStatus !== "approved") {
    throw new AppError(
      "validation_failed",
      `${educator.name} isn't approved yet, so this booking can't be assigned to them. ` +
        "Clear their background check first.",
      { fieldErrors: { educatorSlug: "Not an approved educator." } },
    );
  }

  return educator;
}

// ---------------------------------------------------------------------------
// Can't confirm → refund
// ---------------------------------------------------------------------------

const STATUS_WORDS: Record<string, string> = {
  pending_payment: "not paid yet",
  paid_unconfirmed: "waiting on a coordinator",
  confirmed: "already confirmed",
  completed: "already completed",
  no_show: "recorded as a no-show",
  refunded: "already refunded",
  partially_refunded: "partially refunded",
  disputed: "under dispute",
  expired: "expired",
};

/**
 * The coordinator can't fulfil a paid booking, so the parent gets their money
 * back — in full, because the platform failed to deliver rather than the parent
 * changing their mind. (The ≥24h/no-show refund policy in §8 governs *parent*
 * cancellations; that path is separate and not built here.)
 *
 * The refund is created at Stripe and the booking is left for
 * `charge.refunded` to move to `refunded`, exactly as every other refund on the
 * platform is recorded. What this does write immediately is `cancelledAt` and
 * the audit row, so the queue stops showing the booking as awaiting a decision
 * the moment the coordinator makes one.
 */
export async function cannotConfirmBooking(
  bookingId: string,
  input: CannotConfirmBookingRequest,
  actor: BookingActor,
  ctx: RequestContext,
): Promise<{ reference: string; refundedCents: number }> {
  const prepared = await db.transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);

    if (booking.status !== "paid_unconfirmed") {
      throw new AppError(
        "conflict",
        `That booking is ${STATUS_WORDS[booking.status]}, so there's nothing to refund here.`,
      );
    }

    const [payment] = await tx
      .select({
        id: payments.id,
        status: payments.status,
        stripePaymentIntentId: payments.stripePaymentIntentId,
        amountReceivedCents: payments.amountReceivedCents,
        amountRefundedCents: payments.amountRefundedCents,
      })
      .from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "succeeded")))
      .limit(1);

    if (!payment?.stripePaymentIntentId) {
      throw new AppError(
        "conflict",
        "No settled payment is on this booking yet. Wait for the payment to land before refunding.",
      );
    }

    await tx
      .update(bookings)
      .set({ cancelledAt: new Date(), coordinatorId: actor.userId })
      .where(eq(bookings.id, bookingId));

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "booking.cannot_confirm",
      entityType: "booking",
      entityId: bookingId,
      before: { status: booking.status },
      after: {
        reason: input.reason,
        refundCents: payment.amountReceivedCents - payment.amountRefundedCents,
        intentId: payment.stripePaymentIntentId,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { booking, payment };
  });

  const refundCents =
    prepared.payment.amountReceivedCents - prepared.payment.amountRefundedCents;

  /*
   * Keyed on the booking, so a double-click or a retried request reaches Stripe
   * as the same refund rather than two. `requested_by_customer` is wrong here —
   * the platform couldn't fulfil it, and the reason code is what a dispute
   * review reads.
   */
  await issueRefund({
    bookingId,
    intentId: prepared.payment.stripePaymentIntentId!,
    // Whatever is left, decided by Stripe rather than by a figure we computed.
    amountCents: null,
    reason: input.reason,
    issuedBy: actor.activeRole,
    keyParts: ["cannot-confirm", bookingId],
    ctx,
  });

  await trySend(
    {
      ...bookingCouldNotConfirmTemplate({
        parentName: prepared.booking.parentName,
        reference: prepared.booking.reference,
        reason: input.reason,
        refundedCents: refundCents,
        currency: prepared.booking.currency,
      }),
      to: prepared.booking.parentEmail,
    },
    { purpose: "booking_cannot_confirm", userId: prepared.booking.parentUserId },
  );

  return { reference: prepared.booking.reference, refundedCents: refundCents };
}

// ---------------------------------------------------------------------------
// Discretionary refunds — the conflict path
// ---------------------------------------------------------------------------

/**
 * Statuses a discretionary refund may act on.
 *
 * `pending_payment` has nothing captured. `disputed` is excluded deliberately
 * and is not an oversight: refunding a charge the bank is already clawing back
 * pays the same money out twice, so a dispute hard-locks the booking until it
 * closes (§8).
 */
const REFUNDABLE_STATUSES = [
  "paid_unconfirmed",
  "confirmed",
  "completed",
  "no_show",
  "partially_refunded",
] as const;

/**
 * Refunds part or all of a booking, at a coordinator's or admin's discretion.
 *
 * This is the conflict path, and it is separate from `cannotConfirmBooking` on
 * purpose: that one is the platform failing to deliver and is always in full,
 * while this is a judgement about how much a family is owed back.
 *
 * Two ceilings, checked in this order because they fail for different reasons
 * and deserve different messages:
 *
 * 1. **The refundable balance** — captured minus already refunded. Binds
 *    everyone, admins included. Stripe would reject the excess anyway; catching
 *    it here means a usable message instead of a card-processor error.
 * 2. **The coordinator cap** — policy, cumulative per booking, and the whole of
 *    the difference between the two staff roles on this surface. An admin has no
 *    cap: in a conflict they can return the entire balance.
 *
 * As everywhere else, the money moves at Stripe and the booking's own status is
 * left to the `charge.refunded` webhook, so a refund issued here is recorded by
 * the same path as one issued from the Stripe dashboard.
 */
export async function refundBooking(
  bookingId: string,
  input: RefundBookingRequest,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ reference: string; refundedCents: number; remainingCents: number }> {
  const prepared = await db.transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);

    if (booking.status === "disputed") {
      throw new AppError(
        "conflict",
        "This payment is under dispute. Refunding it now would pay out twice — " +
          "let the dispute close first.",
      );
    }

    if (!REFUNDABLE_STATUSES.includes(booking.status as (typeof REFUNDABLE_STATUSES)[number])) {
      throw new AppError(
        "conflict",
        `That booking is ${STATUS_WORDS[booking.status]}, so there's nothing to refund.`,
      );
    }

    const [payment] = await tx
      .select({
        id: payments.id,
        stripePaymentIntentId: payments.stripePaymentIntentId,
        amountReceivedCents: payments.amountReceivedCents,
        amountRefundedCents: payments.amountRefundedCents,
      })
      .from(payments)
      // The attempt that actually took money. A booking can carry earlier failed
      // or cancelled attempts, and none of those can be given back.
      .where(and(eq(payments.bookingId, bookingId), gt(payments.amountReceivedCents, 0)))
      .limit(1);

    if (!payment?.stripePaymentIntentId || payment.amountReceivedCents === 0) {
      throw new AppError(
        "conflict",
        "No settled payment is on this booking, so there's nothing to refund.",
      );
    }

    const refundable = payment.amountReceivedCents - payment.amountRefundedCents;

    if (refundable <= 0) {
      throw new AppError("conflict", "This booking has already been refunded in full.");
    }

    if (input.amountCents > refundable) {
      const left = formatCents(refundable, booking.currency);
      throw new AppError(
        "validation_failed",
        `Only ${left} is left to refund on this booking.`,
        { fieldErrors: { amountCents: `At most ${left}.` } },
      );
    }

    /*
     * The cap counts every refund already given on this booking, not just this
     * request. A per-request cap would be decorative — three requests at the
     * ceiling clear any balance.
     */
    if (actor.activeRole === "coordinator") {
      const cumulative = payment.amountRefundedCents + input.amountCents;
      if (cumulative > REFUND_POLICY.coordinatorCapCents) {
        throw new AppError(
          "forbidden",
          `Coordinators can refund up to ${formatCents(
            REFUND_POLICY.coordinatorCapCents,
            booking.currency,
          )} per booking (${formatCents(
            payment.amountRefundedCents,
            booking.currency,
          )} already refunded). ` +
            "An admin can approve more.",
          { fieldErrors: { amountCents: "Above your refund limit." } },
        );
      }
    }

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "booking.refunded_discretionary",
      entityType: "booking",
      entityId: bookingId,
      before: {
        status: booking.status,
        alreadyRefundedCents: payment.amountRefundedCents,
      },
      after: {
        amountCents: input.amountCents,
        reason: input.reason,
        remainingCents: refundable - input.amountCents,
        intentId: payment.stripePaymentIntentId,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { booking, payment, refundable };
  });

  await issueRefund({
    bookingId,
    intentId: prepared.payment.stripePaymentIntentId!,
    amountCents: input.amountCents,
    reason: input.reason,
    issuedBy: actor.activeRole,
    /*
     * Includes what was already refunded, so a double-clicked $10 refund is one
     * refund while a deliberate second $10 refund is a different one. Keyed on
     * the booking alone, every refund after the first would be silently
     * swallowed as a repeat.
     */
    keyParts: [
      "refund",
      bookingId,
      `${prepared.payment.amountRefundedCents}-${input.amountCents}`,
    ],
    ctx,
  });

  const remaining = prepared.refundable - input.amountCents;

  await trySend(
    {
      ...bookingRefundedTemplate({
        parentName: prepared.booking.parentName,
        reference: prepared.booking.reference,
        reason: input.reason,
        refundedCents: input.amountCents,
        currency: prepared.booking.currency,
        partial: remaining > 0,
      }),
      to: prepared.booking.parentEmail,
    },
    { purpose: "booking_refunded", userId: prepared.booking.parentUserId },
  );

  return {
    reference: prepared.booking.reference,
    refundedCents: input.amountCents,
    remainingCents: remaining,
  };
}

/**
 * Sends the refund to Stripe, and records it if that fails.
 *
 * The decision and its audit row commit *before* this runs — holding a row lock
 * open across a network call would block the webhook that records the result.
 * The cost of that ordering is a window where the trail says a refund was issued
 * and no money moved, so a failure writes its own `booking.refund_failed` row.
 * A trail that overstates what happened is worse than no trail.
 */
async function issueRefund(input: {
  bookingId: string;
  intentId: string;
  amountCents: number | null;
  reason: string;
  issuedBy: UserRole | null;
  /**
   * What makes this refund distinct from the next one on the same booking.
   * Passed as parts rather than a built key because `idempotencyKey()` reads the
   * Stripe config and throws when it's absent — evaluated as an argument, that
   * throw would land outside the try below and skip the failure audit entirely.
   */
  keyParts: (string | number)[];
  ctx: RequestContext;
}): Promise<void> {
  try {
    await getStripe().refunds.create(
      {
        payment_intent: input.intentId,
        // Omitted for a full refund, so Stripe returns whatever is left rather
        // than us racing it with a figure that may already be stale.
        ...(input.amountCents === null ? {} : { amount: input.amountCents }),
        reason: "requested_by_customer",
        metadata: {
          bookingId: input.bookingId,
          reason: input.reason.slice(0, 480),
          issuedBy: input.issuedBy ?? "system",
        },
      },
      { idempotencyKey: idempotencyKey(...input.keyParts) },
    );
  } catch (error) {
    await recordAudit(db, {
      actorRole: input.issuedBy,
      action: "booking.refund_failed",
      entityType: "booking",
      entityId: input.bookingId,
      after: {
        amountCents: input.amountCents,
        error: error instanceof Error ? error.message : String(error),
      },
      ip: input.ctx.ip,
      requestId: input.ctx.requestId,
    });
    logger.error(
      { bookingId: input.bookingId, err: error },
      "refund was authorised but Stripe rejected it — money not returned",
    );
    throw error;
  }
}

/** `$12.50` / `$100`, for messages a person reads. */
function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/**
 * Takes the booking row for update and returns it with the parent and requested
 * educator alongside. Every transition starts here — the lock is what serialises
 * confirm, can't-confirm, and the sweep against each other.
 */
async function lockBooking(tx: DbOrTx, bookingId: string) {
  const [booking] = await tx
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      educatorProfileId: bookings.educatorProfileId,
      assignedEducatorId: bookings.assignedEducatorId,
      subjectTopic: bookings.subjectTopic,
      format: bookings.format,
      preferredDate: bookings.preferredDate,
      preferredTime: bookings.preferredTime,
      currency: bookings.currency,
      totalCents: bookings.totalCents,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .for("update")
    .limit(1);

  if (!booking) throw new AppError("not_found", "We couldn't find that booking.");

  // Outside the lock's row but inside the transaction: these are only read.
  const [context] = await tx
    .select({
      parentName: users.fullName,
      parentEmail: users.email,
      parentUserId: users.id,
      requestedEducatorSlug: educatorProfiles.slug,
    })
    .from(bookings)
    .innerJoin(customerProfiles, eq(bookings.customerProfileId, customerProfiles.id))
    .innerJoin(users, eq(customerProfiles.userId, users.id))
    .innerJoin(educatorProfiles, eq(bookings.educatorProfileId, educatorProfiles.id))
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!context) {
    throw new AppError("internal_error", "That booking is missing its parent record.", {
      logContext: { bookingId },
    });
  }

  return { ...booking, ...context };
}

// ---------------------------------------------------------------------------
// Parent and educator views
// ---------------------------------------------------------------------------

/** The parent's own history, newest request first. Allowlisted — no margins. */
export async function listParentBookings(
  principal: AuthenticatedPrincipal,
): Promise<ParentBooking[]> {
  const profile = await requireCustomerProfile(principal.userId);

  const rows = await db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      requestedSlug: educatorProfiles.slug,
      requestedName: educatorProfiles.name,
      assignedEducatorId: bookings.assignedEducatorId,
      subjectTopic: bookings.subjectTopic,
      format: bookings.format,
      durationMinutes: bookings.durationMinutes,
      preferredDate: bookings.preferredDate,
      preferredTime: bookings.preferredTime,
      alternateTime: bookings.alternateTime,
      flexibleTime: bookings.flexibleTime,
      learnerAgeBand: learners.ageBand,
      currency: bookings.currency,
      totalCents: bookings.totalCents,
      frozenQuote: bookings.frozenQuote,
      slaDeadline: bookings.slaDeadline,
      createdAt: bookings.createdAt,
      confirmedAt: bookings.confirmedAt,
      cancelledAt: bookings.cancelledAt,
    })
    .from(bookings)
    .innerJoin(educatorProfiles, eq(bookings.educatorProfileId, educatorProfiles.id))
    .innerJoin(learners, eq(bookings.learnerId, learners.id))
    .where(eq(bookings.customerProfileId, profile.id))
    .orderBy(desc(bookings.createdAt))
    .limit(100);

  if (rows.length === 0) return [];

  const assignedIds = rows
    .map((row) => row.assignedEducatorId)
    .filter((id): id is string => id !== null);

  const assignedById = new Map<string, { slug: string; name: string }>();
  if (assignedIds.length > 0) {
    const assignedRows = await db
      .select({ id: educatorProfiles.id, slug: educatorProfiles.slug, name: educatorProfiles.name })
      .from(educatorProfiles)
      .where(inArray(educatorProfiles.id, assignedIds));
    for (const row of assignedRows) {
      assignedById.set(row.id, { slug: row.slug, name: row.name });
    }
  }

  const paidByBooking = await paymentTotals(rows.map((row) => row.id));

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    requestedEducator: { slug: row.requestedSlug, name: row.requestedName },
    assignedEducator: row.assignedEducatorId
      ? assignedById.get(row.assignedEducatorId) ?? null
      : null,
    subjectTopic: row.subjectTopic,
    format: row.format,
    durationMinutes: row.durationMinutes,
    preferredDate: row.preferredDate,
    preferredTime: row.preferredTime,
    alternateTime: row.alternateTime,
    flexibleTime: row.flexibleTime,
    learnerAgeBand: row.learnerAgeBand,
    currency: row.currency,
    totalCents: row.totalCents,
    amountRefundedCents: paidByBooking.get(row.id)?.refundedCents ?? 0,
    lineItems: frozenLineItems(row.frozenQuote),
    slaDeadline: row.slaDeadline.toISOString(),
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  }));
}

/**
 * The educator's own sessions: **confirmed and assigned to them**, nothing else.
 *
 * The `paid_unconfirmed` queue is invisible here on purpose — an educator learns
 * about a session when a coordinator dispatches it, not when a parent requests
 * them. The address still isn't in this payload; it comes from the audited
 * detail endpoint.
 */
export async function listEducatorAssignments(
  principal: AuthenticatedPrincipal,
): Promise<EducatorAssignment[]> {
  const profile = await educatorProfileForUser(principal.userId);
  if (!profile) {
    throw new AppError("forbidden", "This view is for educator accounts.");
  }

  const rows = await db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      status: bookings.status,
      firstNameEncrypted: learners.firstNameEncrypted,
      focusEncrypted: learners.focusEncrypted,
      ageBand: learners.ageBand,
      subjectTopic: bookings.subjectTopic,
      format: bookings.format,
      durationMinutes: bookings.durationMinutes,
      preferredDate: bookings.preferredDate,
      preferredTime: bookings.preferredTime,
      currency: bookings.currency,
      educatorEarningsCents: bookings.educatorEarningsCents,
      confirmedAt: bookings.confirmedAt,
    })
    .from(bookings)
    .innerJoin(learners, eq(bookings.learnerId, learners.id))
    .where(
      and(
        eq(bookings.assignedEducatorId, profile.id),
        /*
         * `partially_refunded` belongs here: a goodwill refund doesn't un-book a
         * session, and the webhook overwrites the booking's status when one is
         * issued. Leaving it out would quietly drop a session the educator is
         * still expected to teach.
         */
        inArray(bookings.status, [
          "confirmed",
          "partially_refunded",
          "completed",
          "no_show",
        ]),
      ),
    )
    .orderBy(asc(bookings.preferredDate))
    .limit(100);

  /*
   * The same predicate that gates a confirm gates the read. An educator whose
   * approval lapses stops seeing learner names on sessions already assigned to
   * them — the invariant is about the current state of the check, not the state
   * it was in on the day a coordinator clicked Confirm.
   */
  if (profile.verificationStatus !== "approved") {
    throw new AppError(
      "forbidden",
      "Your background check needs to be current before session details are shared.",
    );
  }

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    learnerFirstName: decryptField(row.firstNameEncrypted),
    learnerAgeBand: row.ageBand,
    learnerFocus: row.focusEncrypted ? decryptField(row.focusEncrypted) : null,
    subjectTopic: row.subjectTopic,
    format: row.format,
    durationMinutes: row.durationMinutes,
    preferredDate: row.preferredDate,
    preferredTime: row.preferredTime,
    currency: row.currency,
    earningsCents: row.educatorEarningsCents,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// SLA sweep
// ---------------------------------------------------------------------------

/**
 * Refunds every paid booking whose confirmation deadline has passed.
 *
 * This is the promise behind taking money before anyone has agreed to teach:
 * `confirmationSlaDays` is a commitment, not a hope, and without this the money
 * sits indefinitely on a booking no coordinator ever worked. Driven by the
 * partial index on `slaDeadline`, so it stays one cheap query however many
 * bookings exist.
 *
 * Deliberately reuses `cannotConfirmBooking`, which means the sweep produces the
 * same refund, the same email and the same audit shape a coordinator's decision
 * does — the only difference being the actor.
 */
export async function sweepUnconfirmedBookings(
  ctx: RequestContext,
): Promise<{ sweptIds: string[]; failed: { id: string; error: string }[] }> {
  const due = await db
    .select({ id: bookings.id, reference: bookings.reference })
    .from(bookings)
    .where(
      and(eq(bookings.status, "paid_unconfirmed"), lte(bookings.slaDeadline, new Date())),
    )
    .orderBy(asc(bookings.slaDeadline))
    .limit(50);

  const sweptIds: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const booking of due) {
    try {
      await cannotConfirmBooking(
        booking.id,
        {
          reason:
            "We couldn't confirm an educator for this session within our confirmation window, " +
            "so we've refunded it in full.",
        },
        SYSTEM_ACTOR,
        ctx,
      );
      sweptIds.push(booking.id);
    } catch (error) {
      /*
       * One booking failing must not strand the rest — a single un-refundable
       * row (a dispute opened mid-sweep, a Stripe outage) would otherwise hold
       * every later booking's money too.
       */
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ bookingId: booking.id, err: error }, "SLA sweep failed for booking");
      failed.push({ id: booking.id, error: message });
    }
  }

  if (sweptIds.length > 0 || failed.length > 0) {
    logger.info(
      { swept: sweptIds.length, failed: failed.length },
      "SLA sweep finished",
    );
  }

  return { sweptIds, failed };
}
