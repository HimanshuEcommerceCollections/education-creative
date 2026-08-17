import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  approveEducatorApplicationSchema,
  listEducatorApplicationsQuerySchema,
  reviewEducatorApplicationSchema,
  submitEducatorApplicationSchema,
} from "../contracts/educator-applications.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  approveEducatorApplication,
  getEducatorApplication,
  listEducatorApplications,
  resendEducatorApplicationInvite,
  reviewEducatorApplication,
  submitEducatorApplication,
} from "../services/educator-application.service.ts";

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Sending invite mail, whatever the endpoint. Shared with the staff invite
 * routes deliberately: the thing being limited is outbound mail from the
 * platform's sending domain, so an operator must not be able to multiply their
 * budget by alternating between the two paths.
 */
const inviteEmailLimit = () =>
  rateLimit({ max: 20, windowSeconds: 60 * 60, scope: "invite-email" });

export async function educatorApplicationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public submission from `/become-a-tutor`. No account is created — an
   * applicant has nothing to sign in with until a coordinator approves them.
   *
   * The reply is identical for a new submission and a duplicate, so this can't be
   * used to enumerate who has already applied.
   */
  app.post(
    "/",
    // Its own scope: an applicant shouldn't burn the shared auth budget, and five
    // applications an hour from one address is already generous.
    { preHandler: [rateLimit({ max: 5, windowSeconds: 60 * 60, scope: "apply" })] },
    async (request, reply) => {
      const input = submitEducatorApplicationSchema.parse(request.body);
      await submitEducatorApplication(input, requestContext(request));
      return reply.status(202).send({
        message: "Thanks — we've got your application and we'll be in touch by email.",
      });
    },
  );

  // -------------------------------------------------------------------------
  // Staff review queue. Admin and coordinator both review (§5 permission
  // matrix); the capability gate is `requireStaff`, enforced here, not in the UI.
  // -------------------------------------------------------------------------

  /**
   * The queue, filtered and paged server-side. `total`/`hasMore` are part of the
   * body because the list is newest-first: a caller that fetches one window and
   * filters it locally can't tell an empty queue from an overflowing one.
   */
  app.get("/", { preHandler: [app.requireStaff] }, async (request) => {
    const query = listEducatorApplicationsQuerySchema.parse(request.query);
    return listEducatorApplications(query);
  });

  app.get("/:id", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return getEducatorApplication(id);
  });

  app.patch("/:id/review", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = reviewEducatorApplicationSchema.parse(request.body);
    await reviewEducatorApplication(id, input, request.principal!, requestContext(request));
    return { message: `Application marked ${input.status.replace("_", " ")}.` };
  });

  /**
   * Approval — separate from `/review` because its side effects (account, role
   * grant, profile, invite email) must not be reachable by a plain status edit.
   *
   * The reply reports whether the invite actually left. Claiming it did when the
   * provider refused it is how an approved educator ends up with an account they
   * can never sign into and an operator with no reason to look.
   */
  app.post("/:id/approve", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = approveEducatorApplicationSchema.parse(request.body ?? {});
    const result = await approveEducatorApplication(
      id,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message: result.emailSent
        ? "Approved. An invite to set a password is on its way."
        : "Approved, but the invite email didn't send. Use Resend invite to try again.",
      ...result,
    };
  });

  /**
   * Re-sends the invite for an approved application whose educator hasn't set a
   * password yet. Without this, one provider blip orphans the account for good:
   * approval can't be repeated, and the educator has nothing to sign in with.
   */
  app.post(
    "/:id/resend-invite",
    { preHandler: [app.requireStaff, inviteEmailLimit()] },
    async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const result = await resendEducatorApplicationInvite(
        id,
        request.principal!,
        requestContext(request),
      );
      return {
        message: result.emailSent
          ? "A fresh invite is on its way. It's good for 7 days."
          : "The invite still didn't send — check the email provider before retrying.",
        ...result,
      };
    },
  );
}
