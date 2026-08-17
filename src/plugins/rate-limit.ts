import type { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "../lib/app-error.ts";
import { rateLimitStore } from "../services/rate-limit/index.ts";
import { clientIp } from "./request-context.ts";

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  windowSeconds: number;
  /**
   * Groups the counter. Defaults to the route's own path, so each endpoint gets
   * its own budget.
   *
   * Sharing one bucket across all credential routes was tried and reverted: it
   * doesn't buy anything, because the thing being protected — password guessing —
   * only happens at `/auth/login`, and cycling to `/auth/forgot-password` gains an
   * attacker nothing. What it did do was let one user's password-reset attempts
   * eat their own login allowance.
   *
   * Set it explicitly only to deliberately group routes that share a purpose.
   */
  scope?: string;
}

/**
 * What the counter is keyed on.
 *
 * `clientIp` reads the BFF's forwarded header only on a hop that authenticated
 * itself — see `request-context.ts`. Without that condition an attacker rotates
 * one header to get a fresh bucket per request, which makes every limit here
 * decorative.
 */
function clientKey(request: FastifyRequest): string {
  return clientIp(request) ?? "unknown";
}

/**
 * Builds a preHandler that enforces one limit.
 *
 * Replaces `@fastify/rate-limit` so the counting lives behind `RateLimitStore`,
 * which a shared backend can be dropped into without touching a route. Today that
 * store is in-process, so on serverless the limit holds per instance rather than
 * globally — see `services/rate-limit/index.ts`.
 */
export function rateLimit(options: RateLimitOptions) {
  return async function rateLimitGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // The registered route pattern, not the concrete URL — otherwise a path
    // parameter would give every value its own bucket.
    const scope = options.scope ?? request.routeOptions?.url ?? request.url;
    const key = `rl:${scope}:${clientKey(request)}`;
    const result = await rateLimitStore.consume(
      key,
      options.max,
      options.windowSeconds,
    );

    reply.header("X-RateLimit-Limit", String(options.max));
    reply.header("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      reply.header("Retry-After", String(result.retryAfterSeconds));
      request.log.warn(
        { scope, retryAfterSeconds: result.retryAfterSeconds },
        "rate limit exceeded",
      );
      throw new AppError(
        "rate_limited",
        "Too many attempts. Please wait a moment and try again.",
      );
    }
  };
}

/** Credential endpoints — login, signup, reset. Per-route, deliberately tight. */
export const strictLimit = () => rateLimit({ max: 10, windowSeconds: 10 * 60 });

/** Endpoints a legitimate user might retry a few times. */
export const moderateLimit = () => rateLimit({ max: 30, windowSeconds: 10 * 60 });

/**
 * Session introspection and sign-out. Deliberately roomy rather than absent: the
 * BFF calls `GET /auth/session` on most page loads, and a page with several server
 * components can call it more than once, so a ten-minute credential-style budget
 * would break normal browsing. What this stops is an unauthenticated flood of a
 * route that runs two queries per call.
 */
export const sessionLimit = () => rateLimit({ max: 120, windowSeconds: 60 });
