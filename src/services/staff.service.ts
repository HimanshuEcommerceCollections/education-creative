import { and, desc, eq, inArray, isNull, sql as rawSql } from "drizzle-orm";

import { STAFF_ROLES, type UserRole } from "../contracts/roles.ts";
import type { InviteCoordinatorRequest, StaffMember } from "../contracts/staff-invites.ts";
import { db } from "../db/client.ts";
import { userRoles, users } from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { createInvitedUser, type RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import { trySend } from "./email/index.ts";
import { staffInviteTemplate } from "./email/templates.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/**
 * Invites a coordinator. This is the staff counterpart of educator approval and
 * shares its plumbing end to end: `createInvitedUser` makes an `invited` account
 * with no password, grants the role, and issues the single-use token; the
 * invitee activates through the same `/auth/accept-invite` path. There is no
 * other way a coordinator account comes to exist — "staff are invited, never
 * self-created" is structural, exactly as it is for educators.
 *
 * Admin-only by the route guard: role grants belong to admins (§5), so a
 * coordinator can review educators but cannot mint another coordinator.
 */
export async function inviteCoordinator(
  input: InviteCoordinatorRequest,
  inviter: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ userId: string }> {
  // Same rule as educator approval: an address that already has an account
  // can't be given a second one. Granting the coordinator role to an existing
  // user is a deliberate, separate act — not a side effect of an invite form.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(rawSql`lower(${users.email}) = ${input.email}`, isNull(users.deletedAt)))
    .limit(1);

  if (existing) {
    throw new AppError(
      "conflict",
      "That email already has an account. Grant the coordinator role to the " +
        "existing user instead of sending an invite.",
      { logContext: { existingUserId: existing.id } },
    );
  }

  const result = await db.transaction(async (tx) => {
    const { userId, token } = await createInvitedUser(tx, {
      email: input.email,
      fullName: input.fullName,
      role: "coordinator",
      grantedBy: inviter.userId,
      phone: input.phone ?? null,
    });

    await recordAudit(tx, {
      actorId: inviter.userId,
      actorRole: inviter.activeRole,
      action: "staff.coordinator_invited",
      entityType: "users",
      entityId: userId,
      after: { email: input.email, role: "coordinator" },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { userId, token };
  });

  // If this fails the account and role still exist and the token is live for
  // 7 days; the logged context identifies who needs a resend.
  await trySend(
    { ...staffInviteTemplate(input.fullName, result.token, "coordinator"), to: input.email },
    { purpose: "staff_invite", userId: result.userId },
  );

  return { userId: result.userId };
}

/**
 * Everyone holding a staff role, for the admin's directory. One entry per
 * person even when they hold both staff roles; non-staff grants (a coordinator
 * who is also a customer) are deliberately not listed — this is a staffing
 * view, not a full account inspector.
 */
export async function listStaff(): Promise<StaffMember[]> {
  const rows = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      status: users.status,
      createdAt: users.createdAt,
      role: userRoles.role,
    })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(inArray(userRoles.role, [...STAFF_ROLES]), isNull(users.deletedAt)))
    .orderBy(desc(users.createdAt));

  const byUser = new Map<string, StaffMember & { roles: UserRole[] }>();
  for (const row of rows) {
    const entry = byUser.get(row.userId);
    if (entry) {
      entry.roles.push(row.role);
    } else {
      byUser.set(row.userId, {
        userId: row.userId,
        fullName: row.fullName,
        email: row.email,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        roles: [row.role],
      });
    }
  }

  return [...byUser.values()];
}
