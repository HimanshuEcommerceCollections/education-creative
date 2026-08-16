import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  inviteTokenQuerySchema,
  loginRequestSchema,
  resendVerificationRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  verifyEmailRequestSchema,
} from "../contracts/auth.ts";
import { env } from "../env.ts";
import { AppError } from "../lib/app-error.ts";
import { moderateLimit, sessionLimit, strictLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  acceptInvite,
  changePassword,
  login,
  logout,
  logoutEverywhere,
  requestPasswordReset,
  resendInvite,
  resendVerification,
  resetPassword,
  signup,
  verifyEmail,
} from "../services/auth.service.ts";
import { peekEmailToken } from "../services/email-token.service.ts";
import { db } from "../db/client.ts";
import { users } from "../db/schema/index.ts";
import { eq } from "drizzle-orm";
import {
  loadRoles,
  purgeExpiredAuthRows,
  toSessionResponse,
} from "../services/session.service.ts";
import { resolveActiveRole } from "../contracts/roles.ts";

const userIdParamsSchema = z.object({ userId: z.uuid() });

/**
 * Authorises a scheduler-driven route with a bearer secret instead of a session.
 *
 * Timing-safe, and closed when `CRON_SECRET` is unset — an unconfigured scheduler
 * secret must mean "nobody can run this", never "anybody can".
 */
function requireCronSecret(request: FastifyRequest): void {
  const expected = env.CRON_SECRET;
  const header = request.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected ?? "");
  const ok =
    expected !== undefined && a.length === b.length && timingSafeEqual(a, b);

  if (!ok) {
    request.log.warn("rejected cron request: bad or missing CRON_SECRET");
    throw new AppError("unauthenticated", "Not authorised.");
  }
}

/**
 * Every route here returns the plaintext session token in the body rather than
 * setting a cookie. The Next BFF is the only thing that owns a cookie; the
 * browser never sees this response.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Signup — customers only. Educators apply; staff are invited.
  // -------------------------------------------------------------------------
  app.post(
    "/signup",
    { preHandler: [strictLimit()] },
    async (request, reply) => {
      const input = signupRequestSchema.parse(request.body);
      const result = await signup(input, requestContext(request));
      return reply.status(201).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // Login — the single entry point for all four roles
  // -------------------------------------------------------------------------
  app.post("/login", { preHandler: [strictLimit()] }, async (request) => {
    const input = loginRequestSchema.parse(request.body);
    return login(input, requestContext(request));
  });

  // -------------------------------------------------------------------------
  // Session introspection — the only thing the BFF trusts
  // -------------------------------------------------------------------------
  app.get(
    "/session",
    { preHandler: [sessionLimit(), app.authenticate] },
    async (request) => {
      return toSessionResponse(request.principal!);
    },
  );

  app.post(
    "/logout",
    { preHandler: [sessionLimit(), app.authenticate] },
    async (request) => {
      await logout(request.principal!.sessionId);
      return { message: "Signed out." };
    },
  );

  app.post(
    "/logout-everywhere",
    { preHandler: [sessionLimit(), app.authenticate] },
    async (request) => {
      await logoutEverywhere(request.principal!.userId);
      return { message: "Signed out on every device." };
    },
  );

  /**
   * Password change for a signed-in user, re-authenticated with the current one.
   *
   * Limited as tightly as login: this endpoint verifies a password, so it is a
   * guessing surface even behind a session, and it revokes sessions on success.
   */
  app.post(
    "/change-password",
    { preHandler: [strictLimit(), app.authenticate] },
    async (request) => {
      const input = changePasswordRequestSchema.parse(request.body);
      const result = await changePassword(
        request.principal!,
        input,
        requestContext(request),
      );
      return {
        message:
          result.revokedSessions > 0
            ? `Your password is updated. You've been signed out on ${result.revokedSessions} other device(s).`
            : "Your password is updated.",
        ...result,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Email verification
  // -------------------------------------------------------------------------
  app.post(
    "/verify-email",
    { preHandler: [moderateLimit()] },
    async (request) => {
      const { token } = verifyEmailRequestSchema.parse(request.body);
      await verifyEmail(token, requestContext(request));
      return { message: "Your email is confirmed." };
    },
  );

  app.post(
    "/resend-verification",
    { preHandler: [strictLimit()] },
    async (request) => {
      const { email } = resendVerificationRequestSchema.parse(request.body);
      await resendVerification(email);
      // Same reply whether or not the address exists.
      return { message: "If that address needs confirming, a new link is on its way." };
    },
  );

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------
  app.post(
    "/forgot-password",
    { preHandler: [strictLimit()] },
    async (request) => {
      const { email } = forgotPasswordRequestSchema.parse(request.body);
      await requestPasswordReset(email);
      return { message: "If that email has an account, a reset link is on its way." };
    },
  );

  app.post(
    "/reset-password",
    { preHandler: [strictLimit()] },
    async (request) => {
      const input = resetPasswordRequestSchema.parse(request.body);
      await resetPassword(input.token, input.password, requestContext(request));
      return { message: "Your password is updated. Please sign in." };
    },
  );

  // -------------------------------------------------------------------------
  // Invite acceptance — educators and staff
  // -------------------------------------------------------------------------

  /**
   * Read-only peek so the set-password page can greet the invitee and show which
   * role they're accepting. Does not consume the token.
   */
  app.get(
    "/invite",
    { preHandler: [moderateLimit()] },
    async (request) => {
      const { token } = inviteTokenQuerySchema.parse(request.query);
      const resolved = await peekEmailToken(token, "invite");

      const [user] = await db
        .select({ email: users.email, fullName: users.fullName, status: users.status })
        .from(users)
        .where(eq(users.id, resolved.userId))
        .limit(1);

      if (!user || user.status !== "invited") {
        throw new AppError("invalid_token", "That invite has already been used.");
      }

      const roles = await loadRoles(db, resolved.userId);
      const role = resolveActiveRole(roles);
      if (!role) {
        throw new AppError("invalid_token", "That invite has no role attached.");
      }

      return {
        email: user.email,
        fullName: user.fullName,
        role,
        expiresAt: resolved.expiresAt.toISOString(),
      };
    },
  );

  app.post(
    "/accept-invite",
    { preHandler: [strictLimit()] },
    async (request, reply) => {
      const input = acceptInviteRequestSchema.parse(request.body);
      const result = await acceptInvite(input, requestContext(request));
      return reply.status(201).send(result);
    },
  );

  /**
   * Re-issues an invite for an account still in `invited` state.
   *
   * Admin-only, and the only way back from a lost or expired invite: the reset and
   * resend-verification flows both refuse these accounts by design, and re-running
   * the approval collides on the email unique index. Issuing a new token
   * invalidates the previous link.
   *
   * Lives here rather than in the staff or educator service because it is the same
   * act for both — the role only decides which template goes out.
   */
  app.post(
    "/invites/:userId/resend",
    { preHandler: [app.requireRole("admin"), moderateLimit()] },
    async (request) => {
      const { userId } = userIdParamsSchema.parse(request.params);
      const result = await resendInvite(
        userId,
        request.principal!,
        requestContext(request),
      );
      return {
        message: result.sent
          ? `A fresh invite is on its way to ${result.email}.`
          : `A fresh invite was issued for ${result.email}, but the email could not be sent — check the mail driver and try again.`,
        ...result,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /**
   * Deletes expired sessions and dead email tokens.
   *
   * Admin-only and idempotent — it only removes rows nothing can reference, so a
   * second call finds less. Exposed the same three ways as the booking sweep: this
   * endpoint, `npm run auth:purge`, and the cron route below.
   */
  app.post(
    "/purge-sessions",
    { preHandler: [app.requireRole("admin")] },
    async () => {
      const result = await purgeExpiredAuthRows();
      return {
        message: `Removed ${result.sessions} expired session(s) and ${result.emailTokens} spent email token(s).`,
        ...result,
      };
    },
  );

  /**
   * The same sweep for a platform scheduler, which has no session to present and
   * can only issue a GET with a bearer secret.
   *
   * Exempt from the internal-secret hook in `app.ts` for that reason — `CRON_SECRET`
   * is this route's authentication, and the route does nothing an unauthenticated
   * caller could benefit from anyway.
   */
  app.get("/cron/purge-sessions", { preHandler: [moderateLimit()] }, async (request) => {
    requireCronSecret(request);
    const result = await purgeExpiredAuthRows();
    request.log.info(result, "purged expired sessions and email tokens");
    return { ok: true, ...result };
  });
}
