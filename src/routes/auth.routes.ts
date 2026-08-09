import type { FastifyInstance } from "fastify";

import {
  acceptInviteRequestSchema,
  forgotPasswordRequestSchema,
  inviteTokenQuerySchema,
  loginRequestSchema,
  resendVerificationRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  verifyEmailRequestSchema,
} from "../contracts/auth.ts";
import { AppError } from "../lib/app-error.ts";
import { moderateLimit, strictLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  acceptInvite,
  login,
  logout,
  logoutEverywhere,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signup,
  verifyEmail,
} from "../services/auth.service.ts";
import { peekEmailToken } from "../services/email-token.service.ts";
import { db } from "../db/client.ts";
import { users } from "../db/schema/index.ts";
import { eq } from "drizzle-orm";
import { loadRoles, toSessionResponse } from "../services/session.service.ts";
import { resolveActiveRole } from "../contracts/roles.ts";

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
  app.get("/session", { preHandler: [app.authenticate] }, async (request) => {
    return toSessionResponse(request.principal!);
  });

  app.post("/logout", { preHandler: [app.authenticate] }, async (request) => {
    await logout(request.principal!.sessionId);
    return { message: "Signed out." };
  });

  app.post("/logout-everywhere", { preHandler: [app.authenticate] }, async (request) => {
    await logoutEverywhere(request.principal!.userId);
    return { message: "Signed out on every device." };
  });

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
}
