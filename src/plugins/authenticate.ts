import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { type UserRole, isStaffRole } from "../contracts/roles.ts";
import { AppError } from "../lib/app-error.ts";
import {
  type AuthenticatedPrincipal,
  resolveSession,
  touchSession,
} from "../services/session.service.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `authenticate`; absent on public routes. */
    principal?: AuthenticatedPrincipal;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves the session and attaches the principal. **This is the enforcement
 * point** — the Next app's `proxy.ts` only checks whether a cookie exists, for
 * redirects, and is never trusted for access decisions.
 */
async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    throw new AppError("unauthenticated", "Sign in to continue.");
  }

  const principal = await resolveSession(token);
  if (!principal) {
    throw new AppError("unauthenticated", "Your session has expired. Sign in again.");
  }

  request.principal = principal;

  /*
   * Slide the idle window. Awaited: an un-awaited promise on serverless races the
   * end of the response, and the instance freezing first means an active user's
   * window silently stops sliding until their session simply expires under them.
   *
   * The cost is one indexed UPDATE, and `touchSession` skips it entirely unless the
   * window or `lastSeenAt` has actually moved. A failure is still only logged — a
   * lost touch shortens a session, which is not worth failing a request over.
   */
  try {
    await touchSession(principal);
  } catch (error) {
    request.log.warn({ err: error }, "failed to extend session idle window");
  }
}

/**
 * Capability gate. Fails closed: an unknown role or a roleless principal never
 * reaches the handler.
 */
function requireRole(...allowed: UserRole[]) {
  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await authenticate(request, reply);
    const principal = request.principal!;

    // Checked against `activeRole` rather than the full role set: a multi-role
    // user acts as exactly one role per session.
    if (!allowed.includes(principal.activeRole)) {
      throw new AppError("forbidden", "You don't have access to that.");
    }
  };
}

/** Admin or coordinator. Most staff surfaces want this rather than a bare role. */
const requireStaff = async function staffGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticate(request, reply);
  if (!isStaffRole(request.principal!.activeRole)) {
    throw new AppError("forbidden", "You don't have access to that.");
  }
};

export const authPlugin = fp(
  async (app) => {
    app.decorate("authenticate", authenticate);
    app.decorate("requireRole", requireRole);
    app.decorate("requireStaff", requireStaff);
  },
  { name: "auth-plugin" },
);

declare module "fastify" {
  interface FastifyInstance {
    /** Valid session only, with no role check. */
    authenticate: typeof authenticate;
    requireRole: typeof requireRole;
    requireStaff: typeof requireStaff;
  }
}
