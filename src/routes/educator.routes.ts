import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  listEducatorsQuerySchema,
  setEducatorVerificationSchema,
  staffUpdateEducatorProfileSchema,
  updateEducatorProfileSchema,
} from "../contracts/educators.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  getEducatorProfile,
  getOwnEducatorProfile,
  listEducatorProfiles,
  listPublicEducators,
  setEducatorVerification,
  updateEducatorProfileAsStaff,
  updateOwnEducatorProfile,
} from "../services/educator.service.ts";
import { listPublishedReviews } from "../services/review.service.ts";

const slugParamsSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(120),
});

/**
 * The two anonymous reads on this prefix — the directory and one educator's
 * reviews. One shared scope on purpose: they are the same public browse surface,
 * and separate budgets would only hand a scripted caller twice the allowance for
 * no gain to anyone browsing normally. Roomy, because a profile page fetches both
 * and a visitor may open several.
 */
const publicReadLimit = () =>
  rateLimit({ max: 120, windowSeconds: 60, scope: "educator-public" });

/**
 * Educator profiles. Three audiences on one prefix:
 *
 * - `/me` is the educator's own profile. It takes no identifier, so there is
 *   nothing to tamper with to reach another educator's record.
 * - `/directory` and `/:slug/reviews` are **public and unauthenticated**, the
 *   only routes here that are. They are what a visitor browsing tutors reads, and
 *   both are strict allowlist projections rather than trimmed staff payloads —
 *   see the services for what each deliberately leaves out.
 * - everything else is staff, and `PATCH /:slug/verification` is the endpoint the
 *   child-safety invariant depends on: until it runs, an approved applicant is
 *   `pending`, which means unassignable, unable to see their own dashboard, and
 *   every booking against them can only be refunded.
 *
 * Note that `GET /:slug` is staff-only while `GET /:slug/reviews` beneath it is
 * open. That is not an oversight: the staff profile carries the account and the
 * vetting record, the reviews carry neither.
 *
 * Verification is `requireStaff`, not admin: clearing a background check is the
 * coordinator's job under §5, the same as reviewing the application that led to
 * it. What coordinators cannot do is anything on the `/staff` prefix.
 */
export async function educatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", { preHandler: [app.requireRole("educator")] }, async (request) =>
    getOwnEducatorProfile(request.principal!),
  );

  /**
   * The educator completes their own profile. `subjects` is the list the booking
   * form offers and the quote path validates against, so this is also how an
   * educator becomes bookable for the right topics — and only those.
   */
  app.patch("/me", { preHandler: [app.requireRole("educator")] }, async (request) => {
    const input = updateEducatorProfileSchema.parse(request.body);
    const profile = await updateOwnEducatorProfile(
      input,
      request.principal!,
      requestContext(request),
    );
    return { message: "Profile updated.", profile };
  });

  // -------------------------------------------------------------------------
  // Public. No session, and nothing here that a session would reveal more of.
  // -------------------------------------------------------------------------

  /**
   * The public roster. A static path, so Fastify's router matches it ahead of
   * `/:slug` below and no educator can shadow it by taking that slug.
   */
  app.get("/directory", { preHandler: [publicReadLimit()] }, async () =>
    listPublicEducators(),
  );

  /**
   * One educator's published reviews and their aggregate. Free of any parent
   * name, email or learner name — the reviewer is an initial and an age band,
   * which is the whole of the attribution.
   */
  app.get("/:slug/reviews", { preHandler: [publicReadLimit()] }, async (request) => {
    const { slug } = slugParamsSchema.parse(request.params);
    return listPublishedReviews(slug);
  });

  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------

  /**
   * The staff directory. Filter by `verificationStatus` to work the queue that
   * matters — `pending` is every educator with an account and no clearance.
   */
  app.get("/", { preHandler: [app.requireStaff] }, async (request) => {
    const query = listEducatorsQuerySchema.parse(request.query);
    return listEducatorProfiles(query);
  });

  app.get("/:slug", { preHandler: [app.requireStaff] }, async (request) => {
    const { slug } = slugParamsSchema.parse(request.params);
    return getEducatorProfile(slug);
  });

  app.patch("/:slug", { preHandler: [app.requireStaff] }, async (request) => {
    const { slug } = slugParamsSchema.parse(request.params);
    const input = staffUpdateEducatorProfileSchema.parse(request.body);
    const profile = await updateEducatorProfileAsStaff(
      slug,
      input,
      request.principal!,
      requestContext(request),
    );
    return { message: `Profile updated for ${profile.name}.`, profile };
  });

  /**
   * Clear, suspend, or re-open an educator's verification.
   *
   * A suspension applies immediately with nothing to invalidate: the confirm
   * path, the assignment picker, the educator's own session list and every
   * learner-detail read all check the current status rather than a copy of it.
   */
  app.patch("/:slug/verification", { preHandler: [app.requireStaff] }, async (request) => {
    const { slug } = slugParamsSchema.parse(request.params);
    const input = setEducatorVerificationSchema.parse(request.body);
    const profile = await setEducatorVerification(
      slug,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message:
        input.status === "approved"
          ? `${profile.name} is approved and can be assigned bookings.`
          : `${profile.name} is now ${input.status} and can't be assigned bookings.`,
      profile,
    };
  });
}
