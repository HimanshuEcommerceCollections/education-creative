import { and, eq, isNull, sql as rawSql } from "drizzle-orm";

import { LOCKOUT } from "../constants.ts";
import {
  type AcceptInviteRequest,
  type LoginRequest,
  type LoginResponse,
  type SignupRequest,
} from "../contracts/auth.ts";
import {
  CURRENT_SIGNUP_CONSENT_TEXT,
  CURRENT_SIGNUP_CONSENT_VERSION,
} from "../contracts/consent.ts";
import {
  type UserRole,
  homeForRole,
  isStaffRole,
  resolveActiveRole,
} from "../contracts/roles.ts";
import { db, type Tx } from "../db/client.ts";
import {
  authIdentities,
  consentRecords,
  customerProfiles,
  sessions,
  userRoles,
  users,
} from "../db/schema/index.ts";
import { AppError, invalidCredentials } from "../lib/app-error.ts";
import { logger } from "../lib/logger.ts";
import { fakeVerifyDelay, hashPassword, verifyPassword } from "../lib/password.ts";
import { USERS_EMAIL_CONSTRAINT, isUniqueViolation } from "../lib/pg-errors.ts";
import { sha256Hex } from "../lib/tokens.ts";
import { recordAudit } from "./audit.service.ts";
import { trySend } from "./email/index.ts";
import {
  educatorInviteTemplate,
  passwordResetTemplate,
  staffInviteTemplate,
  verifyEmailTemplate,
} from "./email/templates.ts";
import { consumeEmailToken, issueEmailToken } from "./email-token.service.ts";
import {
  type AuthenticatedPrincipal,
  issueSession,
  loadRoles,
  resolveSession,
  revokeAllSessionsForUser,
  revokeOtherSessionsForUser,
  toSessionResponse,
} from "./session.service.ts";

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** Case-insensitive lookup, matching the `lower(email)` unique index. */
function whereEmail(email: string) {
  return and(rawSql`lower(${users.email}) = ${email}`, isNull(users.deletedAt));
}

/**
 * Turns a `users.email` unique violation into the caller's friendly conflict, and
 * returns every other error untouched — an unexpected unique violation is a bug
 * and must surface as one, not as a field error.
 *
 * Exported because every path that inserts a `users` row races the same index.
 * The "this email already has an account" checks in the educator-approval and
 * staff-invite flows run outside their transaction with no lock, so two concurrent
 * approvals both pass the check and the loser arrives here; routing it through
 * this is what stops that being an unmapped 500.
 *
 *   throw mapUserEmailConflict(error, "That email already has an account.");
 */
export function mapUserEmailConflict(error: unknown, message: string): unknown {
  if (!isUniqueViolation(error, USERS_EMAIL_CONSTRAINT)) return error;
  return new AppError("email_in_use", message, { fieldErrors: { email: message } });
}

// ---------------------------------------------------------------------------
// Signup — customers only
// ---------------------------------------------------------------------------

/**
 * Creates a customer account, records guardian consent, issues a verification
 * email, and signs them in.
 *
 * Consent is written inside the same transaction as the user, so an account can
 * never exist without the consent record that justifies collecting anything for
 * it — the COPPA basis in §4 depends on that ordering.
 */
export async function signup(
  input: SignupRequest,
  ctx: RequestContext,
): Promise<LoginResponse> {
  // Hashed before the transaction opens. Argon2id here is ~1.4s of pure-JS
  // derivation, and doing it inside would hold one of ten pooled connections for
  // all of it — `resetPassword` and `acceptInvite` already order it this way.
  const passwordHash = await hashPassword(input.password);

  const result = await db
    .transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          phone: input.phone ?? null,
          status: "active",
          // Ticking the guardian box is the adult attestation.
          ageGateAttestedAt: new Date(),
        })
        .returning({ id: users.id, email: users.email, fullName: users.fullName });

      const userId = user!.id;

      await tx.insert(userRoles).values({ userId, role: "customer" });

      await tx.insert(authIdentities).values({
        userId,
        provider: "password",
        providerAccountId: userId,
      });

      await tx.insert(customerProfiles).values({
        userId,
        subjectsOfInterest: [...new Set(input.subjectsOfInterest)],
      });

      await tx.insert(consentRecords).values({
        userId,
        consentType: "signup_guardian",
        textVersion: CURRENT_SIGNUP_CONSENT_VERSION,
        // Hash of the server's canonical copy, never text from the request.
        textHash: sha256Hex(CURRENT_SIGNUP_CONSENT_TEXT),
        method: "checkbox:signup-form",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      const verification = await issueEmailToken(tx, userId, "email_verification");

      const issued = await issueSession(tx, {
        userId,
        activeRole: "customer",
        rememberMe: false,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      await recordAudit(tx, {
        actorId: userId,
        actorRole: "customer",
        action: "user.signed_up",
        entityType: "users",
        entityId: userId,
        after: { email: user!.email, roles: ["customer"] },
        ip: ctx.ip,
        requestId: ctx.requestId,
      });

      return { userId, user: user!, issued, verificationToken: verification.token };
    })
    .catch((error: unknown) => {
      throw mapUserEmailConflict(error, "That email already has an account.");
    });

  // Outside the transaction: a provider outage must not roll back the account,
  // and must not fail the response either — the account exists, and the address
  // is now taken, so a 500 here would leave the user unable to retry.
  await sendTemplate(
    result.user.email,
    verifyEmailTemplate(result.user.fullName, result.verificationToken),
    { purpose: "email_verification", userId: result.userId },
  );

  const principal = await requirePrincipal(result.issued.token);

  return {
    token: result.issued.token,
    expiresAt: result.issued.idleExpiresAt.toISOString(),
    redirectTo: homeForRole("customer"),
    session: toSessionResponse(principal),
  };
}

// ---------------------------------------------------------------------------
// Login — the single entry point for all four roles
// ---------------------------------------------------------------------------

/**
 * The order of the checks below is load-bearing.
 *
 * Nothing about an account's *state* — locked, suspended, roleless — is disclosed
 * before the password has been verified. Checking the lock first made eight junk
 * attempts followed by a ninth a pre-auth oracle for whether an address exists at
 * all, which contradicts `invalidCredentials`' whole reason for being identical
 * across "no such email", "wrong password" and "no password set". So a locked
 * account still cannot authenticate, but a *guesser* only ever sees the standard
 * invalid-credentials reply, with a full Argon2id verification's worth of work
 * spent either way.
 */
export async function login(
  input: LoginRequest,
  ctx: RequestContext,
): Promise<LoginResponse> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(whereEmail(input.email))
    .limit(1);

  if (!user) {
    // Spend comparable CPU so response time doesn't reveal whether the
    // address exists.
    await fakeVerifyDelay();
    await recordAudit(db, {
      action: "auth.login_failed",
      entityType: "users",
      // The attempted address is the point: without it a sweep through a
      // thousand addresses is a thousand indistinguishable rows. Only the
      // address — never the submitted password, which would make this log a
      // credential list.
      after: { reason: "unknown_email", attemptedEmail: input.email },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw invalidCredentials();
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);

  if (!passwordOk) {
    const lockedNow = await registerFailedAttempt(user.id);
    await recordAudit(db, {
      actorId: user.id,
      action: lockedNow ? "auth.account_locked" : "auth.login_failed",
      entityType: "users",
      entityId: user.id,
      after: lockedNow
        ? { reason: "too_many_failed_attempts", lockMinutes: LOCKOUT.lockMinutes }
        : { reason: "bad_password" },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw invalidCredentials();
  }

  // Correct password, so the lock can be named without telling a guesser
  // anything they didn't already know. It is still enforced: holding the right
  // password does not end the window early.
  if (await isLocked(user.id)) {
    await recordAudit(db, {
      actorId: user.id,
      action: "auth.login_blocked",
      entityType: "users",
      entityId: user.id,
      after: { reason: "account_locked" },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw new AppError(
      "account_locked",
      "Too many attempts. Try again in a few minutes, or reset your password.",
    );
  }

  // An invited account has no password yet, so `passwordOk` above can only be
  // true once they've accepted. Anything other than active still can't sign in.
  if (user.status !== "active") {
    await recordAudit(db, {
      actorId: user.id,
      action: "auth.login_blocked",
      entityType: "users",
      entityId: user.id,
      after: { reason: "account_inactive", status: user.status },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw new AppError(
      "account_inactive",
      user.status === "invited"
        ? "Finish setting up your account using the link we emailed you."
        : "This account isn't active. Please contact support.",
    );
  }

  const roles = await loadRoles(db, user.id);
  const activeRole = resolveActiveRole(roles);

  if (!activeRole) {
    // Authenticated but capability-less. Shouldn't occur (approval grants the
    // role in the same transaction as the account) — fail closed if it does, and
    // record it, because "shouldn't occur" is exactly what wants evidence.
    await recordAudit(db, {
      actorId: user.id,
      action: "auth.login_blocked",
      entityType: "users",
      entityId: user.id,
      after: { reason: "no_role_granted" },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw new AppError(
      "account_inactive",
      "This account doesn't have access configured yet. Please contact support.",
    );
  }

  await clearFailedAttempts(user.id);

  const staff = isStaffRole(activeRole);

  const issued = await db.transaction((tx) =>
    issueSession(tx, {
      userId: user.id,
      activeRole,
      rememberMe: input.rememberMe,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    }),
  );

  // Awaited, not detached. On a serverless invocation the instance can freeze the
  // moment the response completes, so a fire-and-forget insert lands or doesn't
  // depending on timing — and a login record the schema says is always written
  // must not be a coin flip. One indexed insert is an acceptable cost on a path
  // that already spent a full password hash.
  await recordAudit(db, {
    actorId: user.id,
    actorRole: activeRole,
    action: staff ? "auth.staff_login" : "auth.login",
    entityType: "users",
    entityId: user.id,
    after: { activeRole, roles },
    ip: ctx.ip,
    requestId: ctx.requestId,
  });

  const principal = await requirePrincipal(issued.token);

  return {
    token: issued.token,
    expiresAt: issued.idleExpiresAt.toISOString(),
    redirectTo: homeForRole(activeRole),
    session: toSessionResponse(principal),
  };
}

/**
 * Counts one failed attempt and locks the account if that attempt is the one that
 * reaches the threshold. Returns whether it just locked.
 *
 * Both the increment and the lock decision are SQL, in a single statement. Reading
 * the counter in the initial SELECT, spending a full Argon2id verification, then
 * writing `count + 1` computed in JavaScript is a lost update: two hundred
 * concurrent guesses all read zero, all write one, and `maxFailedAttempts` is
 * never reached no matter how many attempts are made in parallel — which is
 * precisely the attack the lockout exists to stop.
 *
 * `lockedUntil` is never written back to null here. Blanking it on a non-locking failure
 * lets a slow request that failed *earlier* clear a lock a later one has just set.
 * Clearing belongs to successful login and to password reset, both of which have earned
 * it.
 */
async function registerFailedAttempt(userId: string): Promise<boolean> {
  const nextCount = rawSql`${users.failedLoginCount} + 1`;
  const locking = rawSql`${nextCount} >= ${LOCKOUT.maxFailedAttempts}`;

  const [row] = await db
    .update(users)
    .set({
      // Reset at the moment of locking, so the window that follows starts fresh.
      failedLoginCount: rawSql`case when ${locking} then 0 else ${nextCount} end`,
      lockedUntil: rawSql`case when ${locking} then now() + make_interval(mins => ${LOCKOUT.lockMinutes}) else ${users.lockedUntil} end`,
    })
    .where(eq(users.id, userId))
    .returning({ failedLoginCount: users.failedLoginCount });

  // The same statement zeroes the counter exactly when it sets the lock, so a
  // zero coming back means this attempt was the one that tripped it.
  return row?.failedLoginCount === 0;
}

/**
 * Whether the lock window is still open, compared in the database rather than in
 * JS — for the same reason `resolveSession` filters session expiry in SQL: a
 * clock-skewed instance must not decide a lock has passed when the row says it
 * hasn't.
 */
async function isLocked(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ locked: rawSql<boolean>`${users.lockedUntil} > now()` })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.locked === true;
}

async function clearFailedAttempts(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function verifyEmail(token: string, ctx: RequestContext): Promise<void> {
  await db.transaction(async (tx) => {
    const { userId } = await consumeEmailToken(tx, token, "email_verification");
    await tx
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    await recordAudit(tx, {
      actorId: userId,
      action: "user.email_verified",
      entityType: "users",
      entityId: userId,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });
}

/**
 * Always resolves, whether or not the address exists — the caller returns the
 * same message either way, so this can't be used to test for accounts.
 *
 * The send is deliberately not awaited: an identical *message* is no use if a real
 * address takes a provider round trip (bounded at 8s) and an unknown one returns
 * after a single SELECT. Latency was the oracle the copy was written to close.
 */
export async function resendVerification(email: string): Promise<void> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      emailVerifiedAt: users.emailVerifiedAt,
      status: users.status,
    })
    .from(users)
    .where(whereEmail(email))
    .limit(1);

  if (!user || user.emailVerifiedAt || user.status !== "active") return;

  const { token } = await db.transaction((tx) =>
    issueEmailToken(tx, user.id, "email_verification"),
  );
  sendTemplateDetached(user.email, verifyEmailTemplate(user.fullName, token), {
    purpose: "email_verification_resend",
    userId: user.id,
  });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/** Same non-enumerating contract as `resendVerification`, send included. */
export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      status: users.status,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(whereEmail(email))
    .limit(1);

  // An invited account with no password yet must use its invite link, not a
  // reset link — sending one would create a second path to the same thing.
  if (!user || user.status !== "active" || !user.passwordHash) return;

  const { token } = await db.transaction((tx) =>
    issueEmailToken(tx, user.id, "password_reset"),
  );
  sendTemplateDetached(user.email, passwordResetTemplate(user.fullName, token), {
    purpose: "password_reset",
    userId: user.id,
  });
}

/**
 * Sets a new password and revokes **every** session for the account — including
 * any an attacker already holds, which is the main point of the reset.
 *
 * Reaching this endpoint proves control of the mailbox, so an unverified address
 * is marked verified here rather than leaving the user to click a second link.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    const { userId } = await consumeEmailToken(tx, token, "password_reset");

    await tx
      .update(users)
      .set({
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        emailVerifiedAt: rawSql`coalesce(${users.emailVerifiedAt}, now())`,
      })
      .where(eq(users.id, userId));

    await revokeAllSessionsForUser(tx, userId);

    await recordAudit(tx, {
      actorId: userId,
      action: "auth.password_reset",
      entityType: "users",
      entityId: userId,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });
}

// ---------------------------------------------------------------------------
// Invite acceptance — educators and staff share this path
// ---------------------------------------------------------------------------

/**
 * Turns an invited account into an active one. This is the only way an educator
 * or staff account ever acquires a password, which is what makes "no
 * self-created educator or staff accounts" structural rather than procedural.
 *
 * Holding the emailed token proves mailbox control, so the address is marked
 * verified. The adult attestation is captured here because these accounts never
 * passed through the signup form's checkbox.
 */
export async function acceptInvite(
  input: AcceptInviteRequest,
  ctx: RequestContext,
): Promise<LoginResponse> {
  const passwordHash = await hashPassword(input.password);

  const { userId, activeRole } = await db.transaction(async (tx) => {
    const consumed = await consumeEmailToken(tx, input.token, "invite");

    const [updated] = await tx
      .update(users)
      .set({
        passwordHash,
        status: "active",
        ageGateAttestedAt: new Date(),
        emailVerifiedAt: rawSql`coalesce(${users.emailVerifiedAt}, now())`,
        failedLoginCount: 0,
        lockedUntil: null,
      })
      /*
       * Keyed on the state as well as the id. Keyed on the id alone, a still-live
       * invite for an account that has since been suspended or soft-deleted would
       * flip it back to `active` with a password of the holder's choosing — the
       * read-only peek route checks `status = 'invited'` for exactly this reason,
       * and the write is the half that matters.
       */
      .where(
        and(
          eq(users.id, consumed.userId),
          eq(users.status, "invited"),
          isNull(users.deletedAt),
        ),
      )
      .returning({ id: users.id });

    // Zero rows means the token was live but the account is no longer invitable.
    if (!updated) {
      throw new AppError("invalid_token", "That invite is no longer valid.");
    }

    // An invited account shouldn't hold a session, but if anything issued one
    // before the password existed, accepting is the moment it stops being valid.
    await revokeAllSessionsForUser(tx, consumed.userId);

    // Idempotent: an account invited, then re-invited, keeps one identity row.
    await tx
      .insert(authIdentities)
      .values({
        userId: consumed.userId,
        provider: "password",
        providerAccountId: consumed.userId,
      })
      .onConflictDoNothing();

    const roles = await loadRoles(tx, consumed.userId);
    const resolved = resolveActiveRole(roles);
    if (!resolved) {
      throw new AppError(
        "account_inactive",
        "This invite has no role attached. Please contact support.",
      );
    }

    await recordAudit(tx, {
      actorId: consumed.userId,
      actorRole: resolved,
      action: "auth.invite_accepted",
      entityType: "users",
      entityId: consumed.userId,
      after: { roles },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { userId: consumed.userId, activeRole: resolved };
  });

  // Sign them straight in — accepting the invite is the credential check.
  const issued = await db.transaction((tx) =>
    issueSession(tx, {
      userId,
      activeRole,
      rememberMe: false,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    }),
  );

  const principal = await requirePrincipal(issued.token);

  return {
    token: issued.token,
    expiresAt: issued.idleExpiresAt.toISOString(),
    redirectTo: homeForRole(activeRole),
    session: toSessionResponse(principal),
  };
}

// ---------------------------------------------------------------------------
// Invitation issuing — used by educator approval and staff invites
// ---------------------------------------------------------------------------

/**
 * Creates an `invited` account with no password and grants it a role. Returns the
 * invite token for the caller to email.
 *
 * Runs inside the caller's transaction so an approval either produces an
 * account, a role, and an invite together, or produces none of them.
 */
export async function createInvitedUser(
  tx: Tx,
  input: {
    email: string;
    fullName: string;
    role: UserRole;
    grantedBy: string;
    phone?: string | null;
  },
): Promise<{ userId: string; token: string }> {
  const [user] = await tx
    .insert(users)
    .values({
      email: input.email,
      passwordHash: null,
      fullName: input.fullName,
      phone: input.phone ?? null,
      status: "invited",
    })
    .returning({ id: users.id })
    .catch((error: unknown) => {
      // Callers check for an existing account before opening their transaction,
      // unlocked, so two concurrent approvals for one address both pass that
      // check and one of them lands here. The index is the actual guarantee.
      throw mapUserEmailConflict(
        error,
        "That email already has an account. Grant the role to the existing user " +
          "instead of sending an invite.",
      );
    });

  const userId = user!.id;

  await tx.insert(userRoles).values({
    userId,
    role: input.role,
    grantedBy: input.grantedBy,
  });

  const { token } = await issueEmailToken(tx, userId, "invite");
  return { userId, token };
}

/**
 * Re-issues an invite for an account still waiting to accept one.
 *
 * Invite recovery has no other route: `forgot-password` refuses an account with no
 * password hash, `resend-verification` refuses a non-active one, and re-running the
 * approval collides on the email unique index — so without this a lost or expired invite
 * leaves the invitee with nothing to click and an admin with nothing to click either.
 *
 * `issueEmailToken` consumes any outstanding invite token first, so the previous
 * link stops working the moment this one is sent; there is never more than one
 * live invite per account.
 */
export async function resendInvite(
  userId: string,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ email: string; sent: boolean }> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!user) throw new AppError("not_found", "No such account.");

  // Only an account that has never accepted. Anything else is a password reset or
  // a support conversation, not a second invite.
  if (user.status !== "invited") {
    throw new AppError(
      "conflict",
      "That account has already been set up. Send a password reset instead.",
    );
  }

  const roles = await loadRoles(db, user.id);
  const role = resolveActiveRole(roles);
  if (!role) {
    throw new AppError(
      "conflict",
      "That invite has no role attached, so there is nothing to accept. Grant the role first.",
    );
  }

  const { token } = await db.transaction(async (tx) => {
    const issued = await issueEmailToken(tx, user.id, "invite");

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "auth.invite_resent",
      entityType: "users",
      entityId: user.id,
      after: { email: user.email, role },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return issued;
  });

  // Awaited: an admin pressing "resend" is entitled to know whether it went out,
  // and the token is committed either way so a failure is recoverable by repeating.
  const sent = await trySend(
    {
      ...(role === "educator"
        ? educatorInviteTemplate(user.fullName, token)
        : staffInviteTemplate(user.fullName, token, role)),
      to: user.email,
    },
    { purpose: "invite_resend", userId: user.id },
  );

  return { email: user.email, sent };
}

// ---------------------------------------------------------------------------
// Authenticated password change
// ---------------------------------------------------------------------------

/**
 * Changes the password of the signed-in account, re-authenticating with the
 * current one first.
 *
 * The re-authentication is the point: a session token alone should not be enough
 * to replace the credential behind it, or a borrowed browser becomes a permanent
 * takeover. It is also the only place in this service that asks for a current
 * password — `/account` linked at the forgot-password flow because this didn't
 * exist.
 *
 * **Every other session is revoked, the caller's is kept.** Someone who has just
 * proved the current password does not need signing out of the page they did it
 * from; anyone else holding a session is the reason the password is changing.
 */
export async function changePassword(
  principal: AuthenticatedPrincipal,
  input: { currentPassword: string; newPassword: string },
  ctx: RequestContext,
): Promise<{ revokedSessions: number }> {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.id, principal.userId), isNull(users.deletedAt)))
    .limit(1);

  if (!user) throw new AppError("unauthenticated", "Sign in to continue.");

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    /*
     * Audited but deliberately *not* counted towards lockout: this is reached
     * only with a valid session, and letting a wrong guess here lock the account
     * would hand anyone with a stolen token a denial-of-service against its owner.
     * The rate limit on the route is what bounds it.
     */
    await recordAudit(db, {
      actorId: principal.userId,
      actorRole: principal.activeRole,
      action: "auth.password_change_failed",
      entityType: "users",
      entityId: principal.userId,
      after: { reason: "wrong_current_password" },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw new AppError("invalid_credentials", "That current password isn't right.", {
      fieldErrors: { currentPassword: "That current password isn't right." },
    });
  }

  const passwordHash = await hashPassword(input.newPassword);

  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, principal.userId));

    const revokedSessions = await revokeOtherSessionsForUser(
      tx,
      principal.userId,
      principal.sessionId,
    );

    await recordAudit(tx, {
      actorId: principal.userId,
      actorRole: principal.activeRole,
      action: "auth.password_changed",
      entityType: "users",
      entityId: principal.userId,
      after: { revokedSessions },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { revokedSessions };
  });
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function logout(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function logoutEverywhere(userId: string): Promise<void> {
  await revokeAllSessionsForUser(db, userId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-reads a freshly minted session so the response body and any later
 * `GET /auth/session` describe the same state, rather than being assembled from
 * two different code paths that could drift.
 */
async function requirePrincipal(token: string): Promise<AuthenticatedPrincipal> {
  const principal = await resolveSession(token);
  if (!principal) {
    throw new AppError("internal_error", "Could not establish a session.");
  }
  return principal;
}

/**
 * Templates carry an empty `to`; the recipient is filled in here.
 *
 * Uses `trySend`, so a provider failure is logged and the request still succeeds —
 * the account or token has already been committed, and failing the response would
 * report an error for work that did happen.
 */
async function sendTemplate(
  to: string,
  template: { to: string; subject: string; text: string; html?: string },
  context: { purpose: string; userId?: string },
): Promise<void> {
  await trySend({ ...template, to }, context);
}

/**
 * Starts a send and returns immediately.
 *
 * Only for the two endpoints whose contract is that the response is identical
 * whether or not the address exists. Awaiting there leaks that answer through
 * latency, which no amount of careful wording in the message fixes. `trySend`
 * already swallows and logs provider failures; the extra catch covers anything
 * before it.
 *
 * Not to be used for a database write: on a serverless invocation the instance can
 * freeze at the end of the response, so a detached promise is best-effort — the
 * price paid here on purpose, and the reason the audit rows in `login` are awaited.
 */
function sendTemplateDetached(
  to: string,
  template: { to: string; subject: string; text: string; html?: string },
  context: { purpose: string; userId?: string },
): void {
  void sendTemplate(to, template, context).catch((error: unknown) => {
    logger.error(
      { err: error, purpose: context.purpose, userId: context.userId },
      "failed to dispatch email — the recipient needs to ask again",
    );
  });
}
