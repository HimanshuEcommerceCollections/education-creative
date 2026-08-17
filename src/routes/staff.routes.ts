import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  grantStaffRoleRequestSchema,
  inviteStaffRequestSchema,
  setUserStatusRequestSchema,
  staffRoleSchema,
} from "../contracts/staff-invites.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  grantStaffRole,
  inviteStaff,
  listStaff,
  resendInvite,
  revokeStaffRole,
  setUserStatus,
} from "../services/staff.service.ts";

const userParamsSchema = z.object({ userId: z.uuid() });
const roleParamsSchema = z.object({ userId: z.uuid(), role: staffRoleSchema });

/** Shared with the educator invite resend — see that file for why. */
const inviteEmailLimit = () =>
  rateLimit({ max: 20, windowSeconds: 60 * 60, scope: "invite-email" });

/**
 * Staff management. Everything here is admin-only — coordinators run operations,
 * but role grants, account status and the staff roster belong to admins alone
 * (§5). The gate is `requireRole("admin")` rather than `requireStaff`, and that
 * difference is the entire boundary between the two staff roles on this surface.
 *
 * The service holds the two guards that make this safe to expose at all: nobody
 * acts on their own account, and the last active admin can't be removed.
 */
export async function staffRoutes(app: FastifyInstance): Promise<void> {
  const requireAdmin = app.requireRole("admin");

  app.get("/", { preHandler: [requireAdmin] }, async () => {
    const items = await listStaff();
    return { items };
  });

  /**
   * Invite an admin or a coordinator. Creates the `invited` account, grants the
   * role, and emails a single-use set-password link — the same acceptance path
   * educator invites use, so there is exactly one way any invited account
   * activates.
   *
   * Rate limited like every other write path: an admin session, or a stolen one,
   * could otherwise drive unbounded mail from the platform's sending domain.
   */
  app.post(
    "/invites",
    { preHandler: [requireAdmin, inviteEmailLimit()] },
    async (request, reply) => {
      const input = inviteStaffRequestSchema.parse(request.body);
      const result = await inviteStaff(input, request.principal!, requestContext(request));
      return reply.status(201).send({
        message: result.emailSent
          ? "Invite sent. They have 7 days to set a password."
          : "The account was created but the invite email didn't send. Use Resend invite.",
        ...result,
      });
    },
  );

  /**
   * Re-send an invite to an account still awaiting its first password. Issuing a
   * new token invalidates the previous link, so an invite that half-arrived can't
   * be used afterwards.
   */
  app.post(
    "/invites/:userId/resend",
    { preHandler: [requireAdmin, inviteEmailLimit()] },
    async (request) => {
      const { userId } = userParamsSchema.parse(request.params);
      const result = await resendInvite(
        userId,
        request.principal!,
        requestContext(request),
      );
      return {
        message: result.emailSent
          ? `A fresh invite is on its way to ${result.fullName}. It's good for 7 days.`
          : "The invite still didn't send — check the email provider before retrying.",
        ...result,
      };
    },
  );

  /**
   * Grant a staff role to an existing account — the promotion path that was CLI
   * only. Idempotent: a role already held reports no change rather than failing.
   */
  app.post("/:userId/roles", { preHandler: [requireAdmin] }, async (request) => {
    const { userId } = userParamsSchema.parse(request.params);
    const input = grantStaffRoleRequestSchema.parse(request.body);
    const result = await grantStaffRole(
      userId,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message: result.changed
        ? // A session's active role is pinned at login, so this is not pedantry.
          `${result.fullName} is now a ${result.role}. They'll need to sign out and back in.`
        : `${result.fullName} already holds the ${result.role} role.`,
      ...result,
    };
  });

  /** Revoke a staff role. Their live sessions go with it. */
  app.delete("/:userId/roles/:role", { preHandler: [requireAdmin] }, async (request) => {
    const { userId, role } = roleParamsSchema.parse(request.params);
    const result = await revokeStaffRole(
      userId,
      role,
      request.principal!,
      requestContext(request),
    );
    return {
      message: `${result.fullName} is no longer a ${result.role}, and has been signed out.`,
      ...result,
    };
  });

  /**
   * Suspend, deactivate, or restore an account. Writes `users.status`, which every
   * session resolution already checks, and deletes the live sessions so a restored
   * account starts from a fresh sign-in.
   */
  app.patch("/:userId/status", { preHandler: [requireAdmin] }, async (request) => {
    const { userId } = userParamsSchema.parse(request.params);
    const input = setUserStatusRequestSchema.parse(request.body);
    const result = await setUserStatus(
      userId,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message:
        result.status === "active"
          ? `${result.fullName} can sign in again.`
          : `${result.fullName} is now ${result.status} and signed out everywhere.`,
      ...result,
    };
  });
}
