import { and, eq, isNull, sql as rawSql } from "drizzle-orm";

import { LOCKOUT } from "../constants.ts";
import {
  type AcceptInviteRequest,
  type LoginRequest,
  type LoginResponse,
  MFA_SETUP_PATH,
  MFA_VERIFY_PATH,
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
import { env } from "../env.ts";
import { AppError, invalidCredentials } from "../lib/app-error.ts";
import { fakeVerifyDelay, hashPassword, verifyPassword } from "../lib/password.ts";
import { USERS_EMAIL_CONSTRAINT, isUniqueViolation } from "../lib/pg-errors.ts";
import { sha256Hex } from "../lib/tokens.ts";
import {
  buildTotpUri,
  createTotpSecret,
  encryptTotpSecret,
  verifyTotpCode,
} from "../lib/totp.ts";
import { recordAudit, recordAuditDetached } from "./audit.service.ts";
import { trySend } from "./email/index.ts";
import {
  passwordResetTemplate,
  verifyEmailTemplate,
} from "./email/templates.ts";
import { consumeEmailToken, issueEmailToken } from "./email-token.service.ts";
import {
  type AuthenticatedPrincipal,
  issueSession,
  loadRoles,
  markMfaSatisfied,
  resolveSession,
  revokeAllSessionsForUser,
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
  const result = await db
    .transaction(async (tx) => {
      const passwordHash = await hashPassword(input.password);

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
        mfaSatisfied: true,
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
      // Matched to the email index specifically: any *other* unique violation in
      // this transaction is a bug and must surface as one, not as a field error.
      if (isUniqueViolation(error, USERS_EMAIL_CONSTRAINT)) {
        throw new AppError("email_in_use", "That email already has an account.", {
          fieldErrors: { email: "That email already has an account." },
        });
      }
      throw error;
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
    outcome: "authenticated",
    token: result.issued.token,
    expiresAt: result.issued.idleExpiresAt.toISOString(),
    redirectTo: homeForRole("customer"),
    session: toSessionResponse(principal, env.MFA_REQUIRED),
  };
}

// ---------------------------------------------------------------------------
// Login — the single entry point for all four roles
// ---------------------------------------------------------------------------

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
      failedLoginCount: users.failedLoginCount,
      lockedUntil: users.lockedUntil,
      mfaEnrolledAt: users.mfaEnrolledAt,
    })
    .from(users)
    .where(whereEmail(input.email))
    .limit(1);

  if (!user) {
    // Spend comparable CPU so response time doesn't reveal whether the
    // address exists.
    await fakeVerifyDelay();
    recordAuditDetached({
      action: "auth.login_failed",
      entityType: "users",
      after: { reason: "unknown_email" },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(
      "account_locked",
      "Too many attempts. Try again in a few minutes, or reset your password.",
    );
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);

  if (!passwordOk) {
    await registerFailedAttempt(user.id, user.failedLoginCount);
    recordAuditDetached({
      actorId: user.id,
      action: "auth.login_failed",
      entityType: "users",
      entityId: user.id,
      after: { reason: "bad_password" },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw invalidCredentials();
  }

  // An invited account has no password yet, so `passwordOk` above can only be
  // true once they've accepted. Anything other than active still can't sign in.
  if (user.status !== "active") {
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
    // role in the same transaction as the account) — fail closed if it does.
    throw new AppError(
      "account_inactive",
      "This account doesn't have access configured yet. Please contact support.",
    );
  }

  await clearFailedAttempts(user.id);

  const staff = isStaffRole(activeRole);
  const mfaEnrolled = user.mfaEnrolledAt !== null;
  const mfaApplies = staff && env.MFA_REQUIRED;

  const outcome = !mfaApplies
    ? "authenticated"
    : mfaEnrolled
      ? "mfa_required"
      : "mfa_enrolment_required";

  const issued = await db.transaction((tx) =>
    issueSession(tx, {
      userId: user.id,
      activeRole,
      rememberMe: input.rememberMe,
      // Staff sessions start inert; the cookie is set but authorises nothing
      // until TOTP is cleared.
      mfaSatisfied: !mfaApplies,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    }),
  );

  recordAuditDetached({
    actorId: user.id,
    actorRole: activeRole,
    action: staff ? "auth.staff_login" : "auth.login",
    entityType: "users",
    entityId: user.id,
    after: { activeRole, roles, outcome },
    ip: ctx.ip,
    requestId: ctx.requestId,
  });

  const principal = await requirePrincipal(issued.token);

  return {
    outcome,
    token: issued.token,
    expiresAt: issued.idleExpiresAt.toISOString(),
    redirectTo:
      outcome === "authenticated"
        ? homeForRole(activeRole)
        : outcome === "mfa_required"
          ? MFA_VERIFY_PATH
          : MFA_SETUP_PATH,
    session: toSessionResponse(principal, env.MFA_REQUIRED),
  };
}

async function registerFailedAttempt(userId: string, currentCount: number): Promise<void> {
  const nextCount = currentCount + 1;
  const shouldLock = nextCount >= LOCKOUT.maxFailedAttempts;

  await db
    .update(users)
    .set({
      failedLoginCount: shouldLock ? 0 : nextCount,
      lockedUntil: shouldLock
        ? new Date(Date.now() + LOCKOUT.lockMinutes * 60_000)
        : null,
    })
    .where(eq(users.id, userId));
}

async function clearFailedAttempts(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Staff TOTP
// ---------------------------------------------------------------------------

/**
 * Generates and stores a secret, but does **not** mark the user enrolled — that
 * happens only once they prove they can produce a code. Refused when already
 * enrolled, so a half-authenticated session can't silently replace a working
 * second factor.
 */
export async function beginMfaEnrolment(
  principal: AuthenticatedPrincipal,
): Promise<{ uri: string; secret: string }> {
  if (!principal.isStaff) {
    throw new AppError("forbidden", "Two-factor authentication is for staff accounts.");
  }
  if (principal.mfaEnrolled) {
    throw new AppError(
      "conflict",
      "This account already has an authenticator app. Ask an admin to reset it.",
    );
  }

  const secret = createTotpSecret();

  await db
    .update(users)
    .set({ mfaSecret: encryptTotpSecret(secret) })
    .where(and(eq(users.id, principal.userId), isNull(users.mfaEnrolledAt)));

  return { uri: buildTotpUri(secret, principal.email), secret };
}

/** Confirms enrolment with a live code, then satisfies MFA for this session. */
export async function completeMfaEnrolment(
  principal: AuthenticatedPrincipal,
  code: string,
  ctx: RequestContext,
): Promise<void> {
  const [row] = await db
    .select({ mfaSecret: users.mfaSecret, mfaEnrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);

  if (!row?.mfaSecret || row.mfaEnrolledAt) {
    throw new AppError("conflict", "Start the setup again — no pending enrolment found.");
  }
  if (!(await verifyTotpCode(row.mfaSecret, code))) {
    throw new AppError("mfa_invalid", "That code didn't match. Try the next one.", {
      fieldErrors: { code: "That code didn't match. Try the next one." },
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ mfaEnrolledAt: new Date() })
      .where(eq(users.id, principal.userId));
    await recordAudit(tx, {
      actorId: principal.userId,
      actorRole: principal.activeRole,
      action: "auth.mfa_enrolled",
      entityType: "users",
      entityId: principal.userId,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });

  await markMfaSatisfied(principal.sessionId);
}

export async function verifyMfa(
  principal: AuthenticatedPrincipal,
  code: string,
): Promise<void> {
  const [row] = await db
    .select({ mfaSecret: users.mfaSecret })
    .from(users)
    .where(and(eq(users.id, principal.userId), rawSql`${users.mfaEnrolledAt} is not null`))
    .limit(1);

  if (!(await verifyTotpCode(row?.mfaSecret ?? null, code))) {
    throw new AppError("mfa_invalid", "That code didn't match. Try the next one.", {
      fieldErrors: { code: "That code didn't match. Try the next one." },
    });
  }

  await markMfaSatisfied(principal.sessionId);
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
  await sendTemplate(user.email, verifyEmailTemplate(user.fullName, token), {
    purpose: "email_verification_resend",
    userId: user.id,
  });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/** Same non-enumerating contract as `resendVerification`. */
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
  await sendTemplate(user.email, passwordResetTemplate(user.fullName, token), {
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
      .where(eq(users.id, consumed.userId))
      .returning({ id: users.id });

    if (!updated) {
      throw new AppError("invalid_token", "That invite is no longer valid.");
    }

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

  // Sign them straight in. Staff still face enrolment before the session does
  // anything, exactly as on a normal login.
  const staff = isStaffRole(activeRole);
  const mfaApplies = staff && env.MFA_REQUIRED;

  const issued = await db.transaction((tx) =>
    issueSession(tx, {
      userId,
      activeRole,
      rememberMe: false,
      mfaSatisfied: !mfaApplies,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    }),
  );

  const principal = await requirePrincipal(issued.token);

  return {
    outcome: mfaApplies ? "mfa_enrolment_required" : "authenticated",
    token: issued.token,
    expiresAt: issued.idleExpiresAt.toISOString(),
    redirectTo: mfaApplies ? MFA_SETUP_PATH : homeForRole(activeRole),
    session: toSessionResponse(principal, env.MFA_REQUIRED),
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
    .returning({ id: users.id });

  const userId = user!.id;

  await tx.insert(userRoles).values({
    userId,
    role: input.role,
    grantedBy: input.grantedBy,
  });

  const { token } = await issueEmailToken(tx, userId, "invite");
  return { userId, token };
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
