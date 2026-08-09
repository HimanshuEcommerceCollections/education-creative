import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

import { SESSION_POLICY } from "../constants.ts";
import type { SessionResponse } from "../contracts/auth.ts";
import { type UserRole, isStaffRole } from "../contracts/roles.ts";
import { db, type DbOrTx } from "../db/client.ts";
import { sessions, userRoles, users } from "../db/schema/index.ts";
import { generateToken, hashToken } from "../lib/tokens.ts";

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
  };
}

/**
 * Slides the idle window forward, clamped to the absolute ceiling so touching a
 * session can never extend its total life.
 *
 * Skipped when less than a minute of the window has elapsed — otherwise every
 * request on a page with a dozen server components becomes a dozen writes.
 */
export async function touchSession(principal: AuthenticatedPrincipal): Promise<void> {
  const policy = policyFor(principal.activeRole);
  const nextIdle = minutesFromNow(policy.idleMinutes);
  const clamped =
    nextIdle > principal.absoluteExpiresAt ? principal.absoluteExpiresAt : nextIdle;

  if (clamped.getTime() - principal.idleExpiresAt.getTime() < 60_000) return;

  await db
    .update(sessions)
    .set({ idleExpiresAt: clamped, lastSeenAt: new Date() })
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

/** Sweeper for the pg-boss job that lands in a later phase. */
export async function deleteExpiredSessions(): Promise<number> {
  const now = new Date();
  const deleted = await db
    .delete(sessions)
    .where(or(lt(sessions.idleExpiresAt, now), lt(sessions.absoluteExpiresAt, now)))
    .returning({ id: sessions.id });
  return deleted.length;
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
