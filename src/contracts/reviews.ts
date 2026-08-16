/**
 * Reviews — what a parent says about a session that actually happened.
 *
 * The rule the whole feature rests on (ARCHITECTURE.md §6): a review is anchored
 * to one **completed** booking, one review per booking, so a rating on a public
 * page can always be traced to a session someone paid for and an educator taught.
 * That is enforced by a NOT NULL UNIQUE `booking_id` in the schema rather than by
 * anything here; these shapes only decide what may be said and what may be read.
 *
 * Nothing in the public shapes identifies a family. A reviewer is an initial and
 * the age band of the learner — the same two facts the design has always shown —
 * because a parent writing about their child's tutor should not be findable from
 * the review, and the learner's name is encrypted at rest precisely so it never
 * reaches a page like this.
 */

import { z } from "zod";

import { learnerAgeBandSchema } from "./bookings.ts";

/** Ratings are whole stars: the UI draws five of them and nothing renders a half. */
const starSchema = z
  .number()
  .int("Choose a whole number of stars.")
  .min(1, "Choose at least one star.")
  .max(5, "Five stars is the highest.");

/**
 * What a parent submits.
 *
 * Only `overallRating` is required. The four facets are what the profile page's
 * "Rating breakdown" is built from, and asking for all five to leave any feedback
 * would cost more reviews than the breakdown is worth — so a parent may answer one
 * question or all of them, and a facet with no answers is simply not shown.
 */
export const submitReviewSchema = z
  .object({
    overallRating: starSchema,
    communicationRating: starSchema.optional(),
    knowledgeRating: starSchema.optional(),
    punctualityRating: starSchema.optional(),
    patienceRating: starSchema.optional(),
    body: z
      .string()
      .trim()
      .max(2000, "Please keep this under 2000 characters.")
      .optional(),
  })
  .strict();

export type SubmitReviewRequest = z.infer<typeof submitReviewSchema>;

/** A moderator's decision. The note is kept on the row and the audit trail. */
export const moderateReviewSchema = z
  .object({
    action: z.enum(["publish", "reject"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type ModerateReviewRequest = z.infer<typeof moderateReviewSchema>;

/**
 * One published review, as a public page sees it.
 *
 * A strict allowlist: no parent name, no email, no learner name, no booking id.
 * `reviewerInitial` and `learnerAgeBand` are the whole of the attribution.
 */
export const publicReviewSchema = z.object({
  id: z.string(),
  /** First letter of the parent's name, upper-cased. */
  reviewerInitial: z.string(),
  learnerAgeBand: learnerAgeBandSchema,
  overallRating: z.number().int(),
  body: z.string().nullable(),
  /** When the review was written, not when it was published. */
  createdAt: z.iso.datetime(),
});

export type PublicReview = z.infer<typeof publicReviewSchema>;

/**
 * The numbers behind the stars.
 *
 * `average` and every facet are one-decimal figures over **published reviews
 * only**, and null when there is nothing to average — which is what lets the UI
 * hide a breakdown rather than draw an empty or invented one. `distribution`
 * counts reviews per star, so the bars can show the shape of the ratings rather
 * than four facets nobody filled in.
 */
export const reviewAggregateSchema = z.object({
  average: z.number().nullable(),
  count: z.number().int(),
  distribution: z.object({
    1: z.number().int(),
    2: z.number().int(),
    3: z.number().int(),
    4: z.number().int(),
    5: z.number().int(),
  }),
  facets: z.object({
    communication: z.number().nullable(),
    knowledge: z.number().nullable(),
    punctuality: z.number().nullable(),
    patience: z.number().nullable(),
  }),
});

export type ReviewAggregate = z.infer<typeof reviewAggregateSchema>;

/** `GET /educators/:slug/reviews` — public. */
export const educatorReviewsResponseSchema = z.object({
  educatorSlug: z.string(),
  aggregate: reviewAggregateSchema,
  items: z.array(publicReviewSchema),
});

export type EducatorReviewsResponse = z.infer<typeof educatorReviewsResponseSchema>;

/**
 * One educator in the public directory.
 *
 * The first server-side source of truth for who can actually be booked, and the
 * only place the cached rating is exposed. `rating` is a one-decimal number rather
 * than the integer the column stores — the scale is a storage detail and no client
 * should have to know it.
 */
export const publicEducatorSchema = z.object({
  slug: z.string(),
  name: z.string(),
  headline: z.string().nullable(),
  subjects: z.array(z.string()),
  minRateCents: z.number().int().nullable(),
  rating: z.number().nullable(),
  reviewCount: z.number().int(),
});

export type PublicEducator = z.infer<typeof publicEducatorSchema>;

/** `GET /educators/directory` — public. */
export const educatorDirectoryResponseSchema = z.object({
  items: z.array(publicEducatorSchema),
});

export type EducatorDirectoryResponse = z.infer<typeof educatorDirectoryResponseSchema>;

/**
 * A review as staff see it while deciding on it.
 *
 * Wider than the public shape on purpose — a moderator needs to know which session
 * and which family they are reading about — and behind a staff guard for the same
 * reason.
 */
export const staffReviewSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "published", "rejected"]),
  bookingReference: z.string(),
  educatorSlug: z.string(),
  educatorName: z.string(),
  parentName: z.string(),
  learnerAgeBand: learnerAgeBandSchema,
  overallRating: z.number().int(),
  communicationRating: z.number().int().nullable(),
  knowledgeRating: z.number().int().nullable(),
  punctualityRating: z.number().int().nullable(),
  patienceRating: z.number().int().nullable(),
  body: z.string().nullable(),
  moderationNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
});

export type StaffReview = z.infer<typeof staffReviewSchema>;

/** `GET /reviews` — staff, paginated the same way the applications queue is. */
export const reviewQueueResponseSchema = z.object({
  items: z.array(staffReviewSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

export const reviewQueueQuerySchema = z.object({
  status: z.enum(["pending", "published", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Whether the parent may still review a booking, for the account page.
 *
 * `eligible` is false with a `reason` rather than the endpoint 404ing, because the
 * booking list needs to know the difference between "not yet" and "already done".
 *
 * `paused` is the `flags.reviews_enabled` switch being off in site configuration.
 * It is its own reason because the parent *is* entitled to review this session and
 * will be able to shortly — telling them "not yet" or showing them nothing would
 * both be wrong, and only this word supports "come back later".
 */
export const reviewEligibilitySchema = z.object({
  bookingId: z.string(),
  eligible: z.boolean(),
  reason: z.enum(["not_completed", "already_reviewed", "paused", "ok"]),
});

export type ReviewEligibility = z.infer<typeof reviewEligibilitySchema>;
