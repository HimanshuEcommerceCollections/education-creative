import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  moderateReviewSchema,
  reviewQueueQuerySchema,
  submitReviewSchema,
} from "../contracts/reviews.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  listReviewQueue,
  moderateReview,
  reviewEligibility,
  submitReview,
} from "../services/review.service.ts";

const idParamsSchema = z.object({ id: z.uuid() });
const bookingParamsSchema = z.object({ bookingId: z.uuid() });

/**
 * Reviews. Two audiences, split by guard rather than by prefix:
 *
 * - the parent writes one and asks whether they still may, both keyed off a
 *   booking id that is checked against their own `customer_profiles` row in the
 *   service — the id in the path is never trusted to belong to the caller;
 * - staff work the queue and decide what becomes public.
 *
 * The public read is **not** here. It lives on `GET /educators/:slug/reviews`,
 * because that is where a profile page asks for it, and it is the only route in
 * this feature with no session at all.
 */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  const requireParent = app.requireRole("customer");

  /**
   * The parent reviews a completed session.
   *
   * Its own budget: writing a review is not something a legitimate parent does
   * often, and one review per completed booking is already the hard ceiling the
   * unique index enforces — this only keeps a scripted caller from hammering it.
   */
  app.post(
    "/bookings/:bookingId",
    {
      preHandler: [
        requireParent,
        rateLimit({ max: 20, windowSeconds: 60 * 60, scope: "review-submit" }),
      ],
    },
    async (request, reply) => {
      const { bookingId } = bookingParamsSchema.parse(request.params);
      const input = submitReviewSchema.parse(request.body);
      const result = await submitReview(
        bookingId,
        input,
        request.principal!,
        requestContext(request),
      );

      return reply.status(201).send({
        message:
          "Thanks — one of our coordinators will read this before it appears on the profile.",
        status: result.status,
      });
    },
  );

  /**
   * Whether the "Leave a review" button should be there at all. Read-only and
   * called once per booking on the account page, so a roomier limit than the
   * write above.
   */
  app.get(
    "/eligibility/:bookingId",
    {
      preHandler: [
        requireParent,
        rateLimit({ max: 120, windowSeconds: 60, scope: "review-eligibility" }),
      ],
    },
    async (request) => {
      const { bookingId } = bookingParamsSchema.parse(request.params);
      return reviewEligibility(bookingId, request.principal!);
    },
  );

  // -------------------------------------------------------------------------
  // Moderation. Both staff roles (§5): deciding what a parent's words look like
  // on a public page is coordinator work, not an admin-only capability.
  // -------------------------------------------------------------------------

  app.get("/", { preHandler: [app.requireStaff] }, async (request) => {
    const query = reviewQueueQuerySchema.parse(request.query);
    return listReviewQueue(query);
  });

  /**
   * Publish or reject. The educator's cached average is rebuilt inside the same
   * transaction, and returned here so the queue screen can show the effect of the
   * decision without a second round trip.
   */
  app.patch("/:id/moderation", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = moderateReviewSchema.parse(request.body);
    const result = await moderateReview(
      id,
      input,
      request.principal!,
      requestContext(request),
    );

    return {
      message:
        result.status === "published"
          ? "Published. It's live on the profile now."
          : "Rejected. It stays out of the public list.",
      ...result,
    };
  });
}
