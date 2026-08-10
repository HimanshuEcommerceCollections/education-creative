import type { FastifyInstance } from "fastify";

import { inviteCoordinatorRequestSchema } from "../contracts/staff-invites.ts";
import { requestContext } from "../plugins/request-context.ts";
import { inviteCoordinator, listStaff } from "../services/staff.service.ts";

/**
 * Staff management. Everything here is admin-only — coordinators run operations,
 * but role grants and the staff roster belong to admins alone (§5). The gate is
 * `requireRole("admin")` rather than `requireStaff`, and that difference is the
 * entire boundary between the two staff roles on this surface.
 */
export async function staffRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", { preHandler: [app.requireRole("admin")] }, async () => {
    const items = await listStaff();
    return { items };
  });

  /**
   * Invite a coordinator. Creates the `invited` account, grants the role, and
   * emails a single-use set-password link — the same acceptance path educator
   * invites use, so there is exactly one way any invited account activates.
   */
  app.post(
    "/invites",
    { preHandler: [app.requireRole("admin")] },
    async (request, reply) => {
      const input = inviteCoordinatorRequestSchema.parse(request.body);
      const result = await inviteCoordinator(
        input,
        request.principal!,
        requestContext(request),
      );
      return reply.status(201).send({
        message: "Invite sent. They have 7 days to set a password.",
        ...result,
      });
    },
  );
}
