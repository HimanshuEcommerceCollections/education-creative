import { and, eq, gt, isNull, lt, ne, or } from "drizzle-orm";

import { SESSION_POLICY } from "../constants.ts";
import type { SessionResponse } from "../contracts/auth.ts";
import { type UserRole, isStaffRole } from "../contracts/roles.ts";
import { db, type DbOrTx } from "../db/client.ts";
import { sessions, userRoles, users } from "../db/schema/index.ts";
import { generateToken, hashToken } from "../lib/tokens.ts";
import { deleteStaleEmailTokens } from "./email-token.service.ts";

/** Which lifetime table applies to a role. */
function policyFor(role: UserRole) {
  if (isStaffRole(role)) return SESSION_POLICY.staff;
  if (role === "educator") return SESSION_POLICY.educator;
  return SESSION_POLICY.customer;
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60_000);
}

export interface IssuedSession {
  /** The plaintext token. Returned once, never recoverable afterwards. */
  token: string;
  sessionId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Mints a session row and returns the plaintext token.
 *
 * `rememberMe` is honoured only where the role's policy allows it, so a staff
 * account ticking "Remember me" on the shared login page silently gets the short
 * staff window rather than a 30-day one.
 */
export async function issueSession(
  tx: DbOrTx,
  input: {
    userId: string;
    activeRole: UserRole;
    rememberMe: boolean;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<IssuedSession> {
  const policy = policyFor(input.activeRole);
  const useRememberMe = input.rememberMe && policy.allowRememberMe;

  const idleExpiresAt = minutesFromNow(
    useRememberMe ? policy.rememberMeIdleMinutes : policy.idleMinutes,
  );
  const absoluteExpiresAt = daysFromNow(
    useRememberMe ? policy.rememberMeAbsoluteDays : policy.absoluteDays,
  );

  const token = generateToken();

  const [row] = await tx
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId: input.userId,
      activeRole: input.activeRole,
      isStaff: isStaffRole(input.activeRole),
      idleExpiresAt,
      absoluteExpiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning({ id: sessions.id });

  return {
    token,
    sessionId: row!.id,
    idleExpiresAt,
    absoluteExpiresAt,
  };
}

export interface AuthenticatedPrincipal {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  emailVerifiedAt: Date | null;
  roles: UserRole[];
  activeRole: UserRole;
  isStaff: boolean;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  /** Read so `touchSession` can tell a stale row from one just written. */
  lastSeenAt: Date;
}

/**
 * Resolves a bearer token to a principal, or null. **This is the authoritative
 * verifier** — `proxy.ts` in the Next app checks only that a cookie exists, for
 * redirect purposes, and is never trusted for access decisions.
 *
 * Expiry is filtered in SQL rather than compared in JS so a clock-skewed app
 * instance can't accept a session the database considers dead.
 */
export async function resolveSession(
  token: string,
): Promise<AuthenticatedPrincipal | null> {
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      activeRole: sessions.activeRole,
      isStaff: sessions.isStaff,
      idleExpiresAt: sessions.idleExpiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      lastSeenAt: sessions.lastSeenAt,
      email: users.email,
      fullName: users.fullName,
      emailVerifiedAt: users.emailVerifiedAt,
      userStatus: users.status,
      userDeletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.idleExpiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
        isNull(users.deletedAt),
        eq(users.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;

  const roles = await loadRoles(db, row.userId);

  // A session whose role was revoked mid-flight must not keep working.
  if (!roles.includes(row.activeRole)) return null;

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    email: row.email,
    fullName: row.fullName,
    emailVerifiedAt: row.emailVerifiedAt,
    roles,
    activeRole: row.activeRole,
    isStaff: row.isStaff,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/** How stale `lastSeenAt` may get before a touch is worth a write on its own. */
const LAST_SEEN_STALE_MS = 5 * 60_000;

/**
 * Slides the idle window forward, clamped to the absolute ceiling so touching a
 * session can never extend its total life.
 *
 * The window slid is the session's **own**, not the short one. Remember-me is not
 * a column, but its consequence is: a remembered session was issued with a longer
 * absolute ceiling than the plain policy grants, and that is what distinguishes
 * the two here. Sliding by `idleMinutes` regardless computed a window earlier than
 * the stored one, so the guard below skipped every write — `lastSeenAt` never
 * moved — and once the remaining life fell under the short idle it began
 * *rewriting* an advertised 7- or 30-day window down to 12 hours.
 *
 * Nothing here may shrink the stored window either way: a live session's idle
 * window is a promise to its holder, and that rule also makes the inference above
 * safe to get wrong near the ceiling.
 *
 * Writes are skipped when neither the window nor `lastSeenAt` has moved
 * meaningfully — otherwise every request on a page with a dozen server components
 * becomes a dozen writes.
 */
export async function touchSession(principal: AuthenticatedPrincipal): Promise<void> {
  const policy = policyFor(principal.activeRole);
  const rememberMe =
    policy.allowRememberMe &&
    daysFromNow(policy.absoluteDays) < principal.absoluteExpiresAt;

  const nextIdle = minutesFromNow(
    rememberMe ? policy.rememberMeIdleMinutes : policy.idleMinutes,
  );
  const clamped =
    nextIdle > principal.absoluteExpiresAt ? principal.absoluteExpiresAt : nextIdle;
  const idleExpiresAt =
    clamped > principal.idleExpiresAt ? clamped : principal.idleExpiresAt;

  const windowMoved = idleExpiresAt.getTime() - principal.idleExpiresAt.getTime();
  const seenAge = Date.now() - principal.lastSeenAt.getTime();
  if (windowMoved < 60_000 && seenAge < LAST_SEEN_STALE_MS) return;

  await db
    .update(sessions)
    .set({ idleExpiresAt, lastSeenAt: new Date() })
    .where(eq(sessions.id, principal.sessionId));
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Used by logout-everywhere and by password reset — a reset must invalidate
 * every existing session, otherwise an attacker who already has one keeps it.
 */
export async function revokeAllSessionsForUser(
  tx: DbOrTx,
  userId: string,
): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}

/**
 * Revokes every session for a user except the one making the request.
 *
 * Used by an authenticated password change: the caller has just re-proved the
 * current password, so signing them out of the page they did it from achieves
 * nothing, while anyone else holding a session — the reason to change a password —
 * must lose it immediately.
 */
export async function revokeOtherSessionsForUser(
  tx: DbOrTx,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const deleted = await tx
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
    .returning({ id: sessions.id });
  return deleted.length;
}

export async function deleteExpiredSessions(): Promise<number> {
  const now = new Date();
  const deleted = await db
    .delete(sessions)
    .where(or(lt(sessions.idleExpiresAt, now), lt(sessions.absoluteExpiresAt, now)))
    .returning({ id: sessions.id });
  return deleted.length;
}

/**
 * Deletes the auth rows that can no longer do anything: sessions past either
 * expiry, and email tokens that are consumed or out of TTL.
 *
 * Both tables only grow otherwise — every login and every emailed link leaves a
 * row behind forever. Driven three ways, none of which requires a job runner in
 * this repo yet: `npm run auth:purge`, an admin endpoint, and a
 * `CRON_SECRET`-authorised GET for a platform scheduler.
 *
 * Idempotent, and safe to run at any time: it deletes only rows nothing can
 * reference, so a second pass finds less and never finds something live.
 */
export async function purgeExpiredAuthRows(): Promise<{
  sessions: number;
  emailTokens: number;
}> {
  return {
    sessions: await deleteExpiredSessions(),
    emailTokens: await deleteStaleEmailTokens(),
  };
}

export async function loadRoles(tx: DbOrTx, userId: string): Promise<UserRole[]> {
  const rows = await tx
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return rows.map((row) => row.role);
}

export function toSessionResponse(principal: AuthenticatedPrincipal): SessionResponse {
  return {
    user: {
      id: principal.userId,
      email: principal.email,
      fullName: principal.fullName,
      emailVerified: principal.emailVerifiedAt !== null,
    },
    roles: principal.roles,
    activeRole: principal.activeRole,
    isStaff: principal.isStaff,
    idleExpiresAt: principal.idleExpiresAt.toISOString(),
    absoluteExpiresAt: principal.absoluteExpiresAt.toISOString(),
  };
}
