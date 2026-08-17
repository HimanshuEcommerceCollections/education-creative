import { and, count, desc, eq, inArray, isNull, ne, sql as rawSql } from "drizzle-orm";

import { STAFF_ROLES, type UserRole, resolveActiveRole } from "../contracts/roles.ts";
import type {
  GrantStaffRoleRequest,
  InviteStaffRequest,
  SetUserStatusRequest,
  StaffMember,
  StaffRole,
} from "../contracts/staff-invites.ts";
import { db, type Tx } from "../db/client.ts";
import { emailTokens, userRoles, users } from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { USERS_EMAIL_CONSTRAINT, isUniqueViolation } from "../lib/pg-errors.ts";
import { createInvitedUser, type RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import { trySend } from "./email/index.ts";
import { educatorInviteTemplate, staffInviteTemplate } from "./email/templates.ts";
import { issueEmailToken } from "./email-token.service.ts";
import {
  type AuthenticatedPrincipal,
  loadRoles,
  revokeAllSessionsForUser,
} from "./session.service.ts";

/**
 * Staff administration (§5). Everything here is admin-only at the route:
 * coordinators run operations, but who holds a capability — and whether an
 * account can authenticate at all — belongs to admins.
 *
 * Two guards run through the whole file and are the reason several of these
 * functions take a lock rather than reading and writing separately:
 *
 * 1. **Nobody acts on their own account.** An admin cannot suspend themselves or
 *    drop their own admin role; both are one click from being locked out of the
 *    surface that would undo it.
 * 2. **The last active admin can't be removed.** Checked inside the transaction,
 *    because two admins demoting each other simultaneously both pass a check made
 *    outside one.
 */

/**
 * Invites a member of staff. This is the staff counterpart of educator approval
 * and shares its plumbing end to end: `createInvitedUser` makes an `invited`
 * account with no password, grants the role, and issues the single-use token; the
 * invitee activates through the same `/auth/accept-invite` path. There is no
 * other way a staff account comes to exist — "staff are invited, never
 * self-created" is structural, exactly as it is for educators.
 *
 * `emailSent` is part of the result because the invite is the account's only
 * route to a password. Reporting success on a send that failed leaves an
 * `invited` row nobody knows to resend to.
 */
export async function inviteStaff(
  input: InviteStaffRequest,
  inviter: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ userId: string; emailSent: boolean }> {
  // Same rule as educator approval: an address that already has an account
  // can't be given a second one. Granting a staff role to an existing user is a
  // deliberate, separate act — not a side effect of an invite form.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(rawSql`lower(${users.email}) = ${input.email}`, isNull(users.deletedAt)))
    .limit(1);

  if (existing) {
    throw new AppError(
      "conflict",
      `That email already has an account. Grant the ${input.role} role to the ` +
        "existing user instead of sending an invite.",
      { logContext: { existingUserId: existing.id } },
    );
  }

  const result = await db
    .transaction(async (tx) => {
      const { userId, token } = await createInvitedUser(tx, {
        email: input.email,
        fullName: input.fullName,
        role: input.role,
        grantedBy: inviter.userId,
        phone: input.phone ?? null,
      });

      await recordAudit(tx, {
        actorId: inviter.userId,
        actorRole: inviter.activeRole,
        action: "staff.invited",
        entityType: "users",
        entityId: userId,
        after: { email: input.email, role: input.role },
        ip: ctx.ip,
        requestId: ctx.requestId,
      });

      return { userId, token };
    })
    .catch((error: unknown) => {
      // The pre-check above narrows the window; the index closes it. Matched to
      // the email index specifically, so any other unique violation still
      // surfaces as the bug it is.
      if (isUniqueViolation(error, USERS_EMAIL_CONSTRAINT)) {
        throw new AppError("email_in_use", "That email already has an account.", {
          fieldErrors: { email: "That email already has an account." },
        });
      }
      throw error;
    });

  // If this fails the account and role still exist and the token is live for
  // 7 days; the resend path below is how it's recovered.
  const emailSent = await trySend(
    { ...staffInviteTemplate(input.fullName, result.token, input.role), to: input.email },
    { purpose: "staff_invite", userId: result.userId },
  );

  return { userId: result.userId, emailSent };
}

/**
 * Re-issues the invite for any account still in `invited` state — staff or
 * educator, since both are created by someone else and activate the same way.
 *
 * Issuing a new token consumes the outstanding one, so the previous link stops
 * working. That is deliberate: two live invites for one account is two chances
 * for the wrong person to use one.
 */
export async function resendInvite(
  userId: string,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ emailSent: boolean; fullName: string }> {
  const [target] = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!target) throw new AppError("not_found", "No such account.");

  if (target.status !== "invited") {
    throw new AppError(
      "conflict",
      "That account has already been set up, so there's no invite to resend. " +
        "They can use the forgotten-password link instead.",
    );
  }

  const roles = await loadRoles(db, userId);
  const role = resolveActiveRole(roles);

  if (!role) {
    throw new AppError(
      "conflict",
      "That invite has no role attached. Grant one before resending it.",
      { logContext: { userId } },
    );
  }

  const issued = await db.transaction(async (tx) => {
    const invite = await issueEmailToken(tx, userId, "invite");

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "user.invite_resent",
      entityType: "users",
      entityId: userId,
      after: { role, expiresAt: invite.expiresAt.toISOString() },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return invite;
  });

  const template =
    role === "educator"
      ? educatorInviteTemplate(target.fullName, issued.token)
      : staffInviteTemplate(target.fullName, issued.token, role);

  const emailSent = await trySend(
    { ...template, to: target.email },
    { purpose: "invite_resend", userId },
  );

  return { emailSent, fullName: target.fullName };
}

/**
 * Everyone holding a staff role, for the admin's directory. One entry per
 * person even when they hold both staff roles; non-staff grants (a coordinator
 * who is also a customer) are deliberately not listed — this is a staffing
 * view, not a full account inspector.
 *
 * The live invite rides along because `status: "invited"` on its own is not
 * actionable: it looks the same the hour an invite goes out and three weeks after
 * it expired, and only one of those needs a resend.
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
        invite: null,
      });
    }
  }

  for (const [userId, invite] of await liveInvites([...byUser.keys()])) {
    byUser.get(userId)!.invite = invite;
  }

  return [...byUser.values()];
}

/**
 * The newest unconsumed invite per account. There is at most one — issuing a
 * token consumes the previous one — but the ordering makes that a property of the
 * data rather than something this query has to trust.
 */
async function liveInvites(
  userIds: string[],
): Promise<Map<string, StaffMember["invite"]>> {
  if (userIds.length === 0) return new Map();

  const rows = await db
    .select({
      userId: emailTokens.userId,
      issuedAt: emailTokens.createdAt,
      expiresAt: emailTokens.expiresAt,
    })
    .from(emailTokens)
    .where(
      and(
        inArray(emailTokens.userId, userIds),
        eq(emailTokens.purpose, "invite"),
        isNull(emailTokens.consumedAt),
      ),
    )
    .orderBy(desc(emailTokens.createdAt));

  const now = new Date();
  const invites = new Map<string, StaffMember["invite"]>();
  for (const row of rows) {
    if (invites.has(row.userId)) continue;
    invites.set(row.userId, {
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expiresAt <= now,
    });
  }
  return invites;
}

// ---------------------------------------------------------------------------
// Role grants
// ---------------------------------------------------------------------------

/**
 * Grants a staff role to an account that already exists.
 *
 * Only the two staff roles: `customer` and `educator` are not grantable here
 * because neither role means anything without the profile row that carries it —
 * a booking needs `customer_profiles`, an educator needs a vetted
 * `educator_profiles`, and minting a capability with nothing behind it is how a
 * role grant turns into a 500 somewhere else.
 */
export async function grantStaffRole(
  userId: string,
  input: GrantStaffRoleRequest,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ fullName: string; role: StaffRole; changed: boolean }> {
  return db.transaction(async (tx) => {
    const target = await lockUser(tx, userId);

    const granted = await tx
      .insert(userRoles)
      .values({ userId, role: input.role, grantedBy: actor.userId })
      .onConflictDoNothing()
      .returning({ id: userRoles.id });

    if (granted.length === 0) {
      return { fullName: target.fullName, role: input.role, changed: false };
    }

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "staff.role_granted",
      entityType: "user_roles",
      entityId: userId,
      after: { role: input.role, email: target.email },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { fullName: target.fullName, role: input.role, changed: true };
  });
}

/**
 * Removes a staff role. Their live sessions go with it: `activeRole` is pinned
 * for a session's life, so a revoked coordinator keeps their pinned role until
 * something ends the session.
 */
export async function revokeStaffRole(
  userId: string,
  role: StaffRole,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ fullName: string; role: StaffRole }> {
  if (userId === actor.userId) {
    throw new AppError(
      "forbidden",
      "You can't change your own roles. Ask another admin to do it.",
    );
  }

  return db.transaction(async (tx) => {
    const target = await lockUser(tx, userId);

    if (role === "admin") await assertNotLastAdmin(tx, userId);

    const removed = await tx
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)))
      .returning({ id: userRoles.id });

    if (removed.length === 0) {
      throw new AppError("conflict", `${target.fullName} doesn't hold the ${role} role.`);
    }

    await revokeAllSessionsForUser(tx, userId);

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "staff.role_revoked",
      entityType: "user_roles",
      entityId: userId,
      before: { role, email: target.email },
      after: null,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { fullName: target.fullName, role };
  });
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

/**
 * Suspends, deactivates, or restores an account.
 *
 * `resolveSession` already refuses a session whose user isn't `active`, so this
 * takes effect on the next request without any help. Deleting the sessions is
 * still the right thing: it means a restored account starts from a fresh sign-in
 * rather than resuming one that predates the suspension, and it makes "are they
 * still signed in?" answerable from the rows.
 */
export async function setUserStatus(
  userId: string,
  input: SetUserStatusRequest,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ fullName: string; status: SetUserStatusRequest["status"] }> {
  if (userId === actor.userId) {
    throw new AppError(
      "forbidden",
      "You can't change your own account's status. Ask another admin to do it.",
    );
  }

  return db.transaction(async (tx) => {
    const target = await lockUser(tx, userId);

    if (target.status === input.status) {
      throw new AppError("conflict", `That account is already ${input.status}.`);
    }

    /*
     * An invited account has no password yet, so marking it active would let it
     * past the status gate and then fail every sign-in attempt as bad
     * credentials — which reads to the account holder as a lost password rather
     * than an invite they never received.
     */
    if (input.status === "active" && !target.passwordHash) {
      throw new AppError(
        "conflict",
        "That account has never set a password, so activating it would leave them " +
          "unable to sign in. Resend their invite instead.",
      );
    }

    if (input.status !== "active") {
      const roles = await loadRoles(tx, userId);
      if (roles.includes("admin")) await assertNotLastAdmin(tx, userId);
    }

    await tx.update(users).set({ status: input.status }).where(eq(users.id, userId));

    if (input.status !== "active") {
      await revokeAllSessionsForUser(tx, userId);
    }

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "staff.status_changed",
      entityType: "users",
      entityId: userId,
      before: { status: target.status },
      after: { status: input.status, reason: input.reason, email: target.email },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { fullName: target.fullName, status: input.status };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Takes the account row for update. Every write above starts here, so a status
 * change and a role change on the same person serialise instead of interleaving.
 */
async function lockUser(tx: Tx, userId: string) {
  const [row] = await tx
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      status: users.status,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .for("update")
    .limit(1);

  if (!row) throw new AppError("not_found", "No such account.");
  return row;
}

/**
 * Refuses a change that would leave nobody holding a usable admin grant.
 *
 * Counts only `active` admins other than this one: an invited or suspended admin
 * cannot sign in, so treating them as cover is how a platform ends up with no
 * reachable admin and no endpoint left to fix it with.
 */
async function assertNotLastAdmin(tx: Tx, userId: string): Promise<void> {
  const [remaining] = await tx
    .select({ total: count() })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(
      and(
        eq(userRoles.role, "admin"),
        ne(userRoles.userId, userId),
        eq(users.status, "active"),
        isNull(users.deletedAt),
      ),
    );

  if ((remaining?.total ?? 0) === 0) {
    throw new AppError(
      "forbidden",
      "That's the last active admin. Promote someone else first — otherwise nobody " +
        "can reach this surface to undo it.",
    );
  }
}
