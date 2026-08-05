import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  approveEducatorApplicationSchema,
  listEducatorApplicationsQuerySchema,
  reviewEducatorApplicationSchema,
  submitEducatorApplicationSchema,
} from "../contracts/educator-applications.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  approveEducatorApplication,
  getEducatorApplication,
  listEducatorApplications,
  reviewEducatorApplication,
  submitEducatorApplication,
} from "../services/educator-application.service.ts";

const idParamsSchema = z.object({ id: z.uuid() });

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
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
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

  app.get("/", { preHandler: [app.requireStaff] }, async (request) => {
    const query = listEducatorApplicationsQuerySchema.parse(request.query);
    const items = await listEducatorApplications(query);
    return { items, limit: query.limit, offset: query.offset };
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
      message: "Approved. An invite to set a password is on its way.",
      ...result,
    };
  });
}
