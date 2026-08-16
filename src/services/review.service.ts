import { and, count, desc, eq, isNull, sql } from "drizzle-orm";

import type {
  EducatorReviewsResponse,
  ModerateReviewRequest,
  PublicReview,
  ReviewAggregate,
  ReviewEligibility,
  ReviewQueueResponse,
  StaffReview,
  SubmitReviewRequest,
} from "../contracts/reviews.ts";
import { FLAG_MESSAGES } from "../constants.ts";
import { db, type DbOrTx, type Tx } from "../db/client.ts";
import {
  bookings,
  customerProfiles,
  educatorProfiles,
  learners,
  reviews,
  users,
} from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { isUniqueViolation } from "../lib/pg-errors.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import { assertFlagEnabled, getEffectiveConfig } from "./config.service.ts";
import { requireCustomerProfile } from "./booking.service.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/**
 * Reviews — the read side of a session that happened (ARCHITECTURE.md §6).
 *
 * Three rules hold throughout:
 *
 * 1. **A review exists only behind a `completed` booking the caller owns.** The
 *    schema's NOT NULL UNIQUE `booking_id` makes "one review per session" a
 *    property of the database; this file supplies the other half — that the
 *    session happened, and that the person writing paid for it.
 * 2. **Nothing reaches a public page without a moderator.** New rows are
 *    `pending`; only `moderateReview` publishes, and only `published` rows are
 *    ever averaged or listed publicly.
 * 3. **The cached aggregates on `educator_profiles` are written here and nowhere
 *    else**, inside the same transaction as the status change that invalidated
 *    them, so the cached figure and the rows it summarises can never disagree.
 */

/**
 * The unique index behind one-review-per-booking. Named here rather than in
 * `pg-errors.ts` because this is the only writer that can trip it — and matching
 * it by name is what stops some *other* unique violation being reported to a
 * parent as "you already reviewed that".
 */
const REVIEW_BOOKING_CONSTRAINT = "reviews_booking_key";

/**
 * How many published reviews a public profile page carries. A cap rather than
 * paging: the aggregate below is computed over every published row regardless,
 * so the list is a sample of the newest opinions, not the evidence for the score.
 */
const PUBLIC_REVIEW_LIMIT = 50;

/** The contract exposes one decimal; the column stores tenths. See `writeCache`. */
function toOneDecimal(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * Every published figure for one educator, in a single pass.
 *
 * `avg()` skips NULLs, which *is* the facet rule: a breakdown is averaged only
 * across the parents who answered that question, and comes back null when nobody
 * did — so the UI hides a bar rather than drawing an invented one. The counts are
 * cast to `int` because the driver hands `count()` back as a string otherwise,
 * and the average to `float8` for the same reason.
 */
async function publishedAggregate(
  dbOrTx: DbOrTx,
  educatorProfileId: string,
): Promise<ReviewAggregate> {
  const [row] = await dbOrTx
    .select({
      count: sql<number>`count(*)::int`,
      average: sql<number | null>`avg(${reviews.overallRating})::float8`,
      star1: sql<number>`(count(*) filter (where ${reviews.overallRating} = 1))::int`,
      star2: sql<number>`(count(*) filter (where ${reviews.overallRating} = 2))::int`,
      star3: sql<number>`(count(*) filter (where ${reviews.overallRating} = 3))::int`,
      star4: sql<number>`(count(*) filter (where ${reviews.overallRating} = 4))::int`,
      star5: sql<number>`(count(*) filter (where ${reviews.overallRating} = 5))::int`,
      communication: sql<number | null>`avg(${reviews.communicationRating})::float8`,
      knowledge: sql<number | null>`avg(${reviews.knowledgeRating})::float8`,
      punctuality: sql<number | null>`avg(${reviews.punctualityRating})::float8`,
      patience: sql<number | null>`avg(${reviews.patienceRating})::float8`,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.educatorProfileId, educatorProfileId),
        eq(reviews.status, "published"),
      ),
    );

  return {
    average: toOneDecimal(row?.average ?? null),
    count: row?.count ?? 0,
    distribution: {
      1: row?.star1 ?? 0,
      2: row?.star2 ?? 0,
      3: row?.star3 ?? 0,
      4: row?.star4 ?? 0,
      5: row?.star5 ?? 0,
    },
    facets: {
      communication: toOneDecimal(row?.communication ?? null),
      knowledge: toOneDecimal(row?.knowledge ?? null),
      punctuality: toOneDecimal(row?.punctuality ?? null),
      patience: toOneDecimal(row?.patience ?? null),
    },
  };
}

/**
 * Rewrites `educator_profiles.rating_cached` and `.review_count_cached` from the
 * published rows.
 *
 * **`rating_cached` is the average multiplied by ten** — `49` means 4.9. The
 * column is an integer, and a whole number of tenths is the only lossless way to
 * keep a one-decimal score in one; the conversion back happens at the contract
 * edge, so nothing outside this file and the directory projection knows the
 * scale. Null, not zero, when there is nothing published: an educator with no
 * reviews has no rating, and zero would sort them below a genuinely bad one.
 *
 * Takes a transaction handle rather than the pool because it is never correct to
 * run this on its own — every caller is a status change that has just made the
 * cached figures wrong.
 */
export async function recomputeEducatorRating(
  tx: Tx,
  educatorProfileId: string,
): Promise<{ average: number | null; count: number }> {
  const aggregate = await publishedAggregate(tx, educatorProfileId);
  const scaled =
    aggregate.average === null ? null : Math.round(aggregate.average * 10);

  await tx
    .update(educatorProfiles)
    .set({ ratingCached: scaled, reviewCountCached: aggregate.count })
    .where(eq(educatorProfiles.id, educatorProfileId));

  return { average: aggregate.average, count: aggregate.count };
}

// ---------------------------------------------------------------------------
// The parent's side
// ---------------------------------------------------------------------------

/**
 * The booking a review would hang off, or a 404.
 *
 * Not-found and not-yours answer identically — the same rule `getBookingStatus`
 * and `getBookingChildDetails` follow. Otherwise the difference between the two
 * errors tells an outsider which booking ids exist and which of them reached a
 * completed session.
 */
async function ownedBooking(bookingId: string, customerProfileId: string) {
  const [booking] = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      customerProfileId: bookings.customerProfileId,
      assignedEducatorId: bookings.assignedEducatorId,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!booking || booking.customerProfileId !== customerProfileId) {
    throw new AppError("not_found", "We couldn't find that booking.");
  }
  return booking;
}

/**
 * Records a parent's review of their own completed session.
 *
 * `completed` is the only status that may produce one, and that is the point of
 * the feature rather than a formality: `no_show` means nobody taught, a refunded
 * booking means the session was undone, and `confirmed` means it hasn't happened
 * yet. None of them has anything to review.
 *
 * The educator is the booking's **assigned** one — the person who actually
 * turned up. A substitution moves the review with the teaching.
 */
export async function submitReview(
  bookingId: string,
  input: SubmitReviewRequest,
  principal: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ reviewId: string; status: "pending" }> {
  await assertFlagEnabled("reviewsEnabled", FLAG_MESSAGES.reviewsPaused);

  const profile = await requireCustomerProfile(principal.userId);
  const booking = await ownedBooking(bookingId, profile.id);

  if (booking.status !== "completed") {
    throw new AppError(
      "conflict",
      "You can review a session once it's been marked as completed.",
    );
  }

  // `assigned_educator_id` is `on delete set null`, so a completed booking can
  // outlive the profile it was taught by. A review with nobody to attribute it
  // to would be an average with no subject.
  if (!booking.assignedEducatorId) {
    throw new AppError(
      "conflict",
      "We can't tell who taught that session, so it can't be reviewed. Please contact us.",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(reviews)
        .values({
          bookingId: booking.id,
          customerProfileId: profile.id,
          educatorProfileId: booking.assignedEducatorId!,
          overallRating: input.overallRating,
          communicationRating: input.communicationRating ?? null,
          knowledgeRating: input.knowledgeRating ?? null,
          punctualityRating: input.punctualityRating ?? null,
          patienceRating: input.patienceRating ?? null,
          body: input.body ?? null,
          // Explicit rather than left to the column default, because "nothing is
          // public until a person says so" is the rule this line implements.
          status: "pending",
        })
        .returning({ id: reviews.id });

      await recordAudit(tx, {
        actorId: principal.userId,
        actorRole: principal.activeRole,
        action: "review.submitted",
        entityType: "reviews",
        entityId: row!.id,
        // The scores, not the words: the prose is on the row, and copying it
        // into an append-only log would outlive any later takedown of it.
        after: {
          bookingId: booking.id,
          educatorProfileId: booking.assignedEducatorId,
          overallRating: input.overallRating,
          hasBody: Boolean(input.body),
          status: "pending",
        },
        ip: ctx.ip,
        requestId: ctx.requestId,
      });

      return { reviewId: row!.id, status: "pending" as const };
    });
  } catch (error) {
    // The unique index is the guarantee, not a pre-check: two submissions racing
    // on the same booking both pass any SELECT, and only one of them can insert.
    if (isUniqueViolation(error, REVIEW_BOOKING_CONSTRAINT)) {
      throw new AppError("conflict", "You've already reviewed that session.");
    }
    throw error;
  }
}

/**
 * Whether the parent may still review a booking.
 *
 * Exists so the account page can offer "Leave a review" only where it will
 * work — an offer that 409s is worse than no offer. It answers 404 on someone
 * else's booking for the same reason `submitReview` does, so it can't be used to
 * probe which sessions exist.
 */
export async function reviewEligibility(
  bookingId: string,
  principal: AuthenticatedPrincipal,
): Promise<ReviewEligibility> {
  const profile = await requireCustomerProfile(principal.userId);
  const booking = await ownedBooking(bookingId, profile.id);

  // A completed booking whose educator record has since gone takes the same
  // branch: `submitReview` refuses it, and the contract's reason set has no
  // narrower word for it. What matters is that the button isn't offered.
  if (booking.status !== "completed" || !booking.assignedEducatorId) {
    return { bookingId: booking.id, eligible: false, reason: "not_completed" };
  }

  /*
   * Checked after ownership, not before: the switch being off is not a reason to
   * tell a stranger which booking ids exist. Checked at all — rather than leaving
   * the refusal to `submitReview` — so a paused platform doesn't hand a parent a
   * form, take their five minutes of writing, and then decline it.
   */
  const { flags } = await getEffectiveConfig();
  if (!flags.reviewsEnabled) {
    return { bookingId: booking.id, eligible: false, reason: "paused" };
  }

  const [existing] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.bookingId, booking.id))
    .limit(1);

  return existing
    ? { bookingId: booking.id, eligible: false, reason: "already_reviewed" }
    : { bookingId: booking.id, eligible: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// The public read
// ---------------------------------------------------------------------------

/**
 * An educator's published reviews and their aggregate, for the public profile
 * page.
 *
 * The projection is an allowlist and the two attribution fields are derived, not
 * selected: `reviewerInitial` is one character of the parent's name and
 * `learnerAgeBand` is a band, so no name, address or email of a family can leave
 * through here even if the query grows a column. The learner's name never even
 * loads — it is encrypted at rest and this function has no reason to decrypt it.
 *
 * A suspended educator's reviews stay readable: they describe sessions that
 * really happened, and hiding them would silently rewrite the record. What
 * suspension does is take the educator out of the directory and off the
 * assignment picker.
 */
export async function listPublishedReviews(
  slug: string,
): Promise<EducatorReviewsResponse> {
  const [educator] = await db
    .select({ id: educatorProfiles.id, slug: educatorProfiles.slug })
    .from(educatorProfiles)
    .where(and(eq(educatorProfiles.slug, slug), isNull(educatorProfiles.deletedAt)))
    .limit(1);

  if (!educator) throw new AppError("not_found", "No such educator.");

  const [rows, aggregate] = await Promise.all([
    db
      .select({
        id: reviews.id,
        parentName: users.fullName,
        learnerAgeBand: learners.ageBand,
        overallRating: reviews.overallRating,
        body: reviews.body,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .innerJoin(bookings, eq(reviews.bookingId, bookings.id))
      .innerJoin(learners, eq(bookings.learnerId, learners.id))
      .innerJoin(customerProfiles, eq(reviews.customerProfileId, customerProfiles.id))
      .innerJoin(users, eq(customerProfiles.userId, users.id))
      .where(
        and(eq(reviews.educatorProfileId, educator.id), eq(reviews.status, "published")),
      )
      .orderBy(desc(reviews.createdAt))
      .limit(PUBLIC_REVIEW_LIMIT),
    publishedAggregate(db, educator.id),
  ]);

  const items: PublicReview[] = rows.map((row) => ({
    id: row.id,
    reviewerInitial: initialOf(row.parentName),
    learnerAgeBand: row.learnerAgeBand,
    overallRating: row.overallRating,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  }));

  return { educatorSlug: educator.slug, aggregate, items };
}

/**
 * The only part of a parent's name that goes public. Falls back to a placeholder
 * rather than an empty string so the UI always has a character to draw.
 */
function initialOf(fullName: string): string {
  return (fullName.trim().charAt(0) || "?").toUpperCase();
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/**
 * The moderation queue, newest first and paged server-side.
 *
 * Wider than the public shape — a moderator needs to know which session and
 * which family they are reading about before deciding — which is why the whole
 * surface is behind `requireStaff`. The count rides along for the same reason the
 * applications queue returns one: newest-first means what falls off the end is
 * the review that has been waiting longest.
 */
export async function listReviewQueue(query: {
  status?: StaffReview["status"];
  limit: number;
  offset: number;
}): Promise<ReviewQueueResponse> {
  const where = query.status ? eq(reviews.status, query.status) : undefined;

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: reviews.id,
        status: reviews.status,
        bookingReference: bookings.reference,
        educatorSlug: educatorProfiles.slug,
        educatorName: educatorProfiles.name,
        parentName: users.fullName,
        learnerAgeBand: learners.ageBand,
        overallRating: reviews.overallRating,
        communicationRating: reviews.communicationRating,
        knowledgeRating: reviews.knowledgeRating,
        punctualityRating: reviews.punctualityRating,
        patienceRating: reviews.patienceRating,
        body: reviews.body,
        moderationNote: reviews.moderationNote,
        createdAt: reviews.createdAt,
        publishedAt: reviews.publishedAt,
      })
      .from(reviews)
      .innerJoin(bookings, eq(reviews.bookingId, bookings.id))
      .innerJoin(learners, eq(bookings.learnerId, learners.id))
      .innerJoin(educatorProfiles, eq(reviews.educatorProfileId, educatorProfiles.id))
      .innerJoin(customerProfiles, eq(reviews.customerProfileId, customerProfiles.id))
      .innerJoin(users, eq(customerProfiles.userId, users.id))
      .where(where)
      .orderBy(desc(reviews.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(reviews).where(where),
  ]);

  const total = totals?.total ?? 0;

  return {
    items: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
    })),
    total,
    hasMore: query.offset + rows.length < total,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * Publishes or rejects one review.
 *
 * The row is taken `FOR UPDATE` and its status re-read inside the transaction:
 * two moderators working the same queue entry would otherwise both pass the
 * no-op check and both recompute the educator's average from a set the other was
 * still changing.
 *
 * The recompute runs here, in the same transaction, rather than after it — a
 * committed status change with a failed recompute would leave a published review
 * that no average counts, which is the one inconsistency a cached figure must
 * never be allowed to show.
 */
export async function moderateReview(
  reviewId: string,
  input: ModerateReviewRequest,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{
  reviewId: string;
  status: StaffReview["status"];
  educatorSlug: string;
  rating: number | null;
  reviewCount: number;
}> {
  const target = input.action === "publish" ? "published" : "rejected";

  return db.transaction(async (tx) => {
    const [review] = await tx
      .select({
        id: reviews.id,
        status: reviews.status,
        educatorProfileId: reviews.educatorProfileId,
        moderationNote: reviews.moderationNote,
        publishedAt: reviews.publishedAt,
      })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .for("update")
      .limit(1);

    if (!review) throw new AppError("not_found", "No such review.");

    if (review.status === target) {
      throw new AppError(
        "conflict",
        target === "published"
          ? "That review is already published."
          : "That review has already been rejected.",
      );
    }

    const moderatedAt = new Date();
    await tx
      .update(reviews)
      .set({
        status: target,
        moderatedBy: actor.userId,
        moderatedAt,
        // A decision with no fresh note keeps the last one rather than wiping the
        // reason the previous moderator recorded.
        moderationNote: input.note ?? review.moderationNote,
        /*
         * When it first went live, and never cleared. A review pulled back down
         * was still public between two dates, and that is a fact worth being able
         * to answer for later.
         */
        publishedAt:
          target === "published" ? review.publishedAt ?? moderatedAt : review.publishedAt,
      })
      .where(eq(reviews.id, reviewId));

    // Both directions move the published set — a rejection can take a live review
    // out of it — so the cache is rebuilt either way.
    const recomputed = await recomputeEducatorRating(tx, review.educatorProfileId);

    const [educator] = await tx
      .select({ slug: educatorProfiles.slug })
      .from(educatorProfiles)
      .where(eq(educatorProfiles.id, review.educatorProfileId))
      .limit(1);

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: `review.${target}`,
      entityType: "reviews",
      entityId: reviewId,
      before: {
        status: review.status,
        publishedAt: review.publishedAt?.toISOString() ?? null,
      },
      after: {
        status: target,
        note: input.note ?? null,
        educatorSlug: educator?.slug ?? null,
        ratingCached: recomputed.average,
        reviewCountCached: recomputed.count,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return {
      reviewId,
      status: target,
      educatorSlug: educator!.slug,
      rating: recomputed.average,
      reviewCount: recomputed.count,
    };
  });
}
