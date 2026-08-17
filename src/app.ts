import { timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import { env, isProduction } from "./env.ts";
import { AppError } from "./lib/app-error.ts";
import { logger } from "./lib/logger.ts";
import { authPlugin } from "./plugins/authenticate.ts";
import { registerErrorHandler } from "./plugins/error-handler.ts";
import { authRoutes } from "./routes/auth.routes.ts";
import { bookingRoutes } from "./routes/booking.routes.ts";
import { configRoutes } from "./routes/config.routes.ts";
import { contactRequestRoutes } from "./routes/contact-request.routes.ts";
import { educatorApplicationRoutes } from "./routes/educator-application.routes.ts";
import { educatorRoutes } from "./routes/educator.routes.ts";
import { pricingRoutes } from "./routes/pricing.routes.ts";
import { reviewRoutes } from "./routes/review.routes.ts";
import { staffRoutes } from "./routes/staff.routes.ts";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.routes.ts";

/**
 * Routes that are reached by something other than the Next BFF and therefore
 * cannot carry the shared secret:
 *
 *   /stripe/webhook   Stripe calls it directly; its signature is its auth.
 *   /healthz          platform and uptime monitors, anonymous by design.
 *   the cron routes   a platform scheduler, which can only send a bearer
 *                     CRON_SECRET and never the BFF's header.
 *
 * Every further scheduler-driven route needs adding here, or it becomes
 * unreachable the moment INTERNAL_API_SECRET is set — and it must carry its own
 * `CRON_SECRET` check, since nothing else gates it.
 */
const INTERNAL_SECRET_EXEMPT_ROUTES = new Set([
  "/healthz",
  "/stripe/webhook",
  "/auth/cron/purge-sessions",
  "/bookings/cron/sweep-unconfirmed",
]);

function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on differing lengths, and a secret's length is not
  // the secret, so comparing lengths first leaks nothing worth having.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Widened to Fastify's own logger interface. Passing the concrete pino type
    // would specialise `FastifyInstance`'s generics, and every route module's
    // plain `FastifyInstance` parameter would then stop matching.
    loggerInstance: logger as FastifyBaseLogger,
    // The platform in front of this service sets the forwarding chain, so
    // `request.ip` is the address that reached it rather than the proxy's. That
    // makes it a usable rate-limit key for a direct caller — but it is derived
    // from a header, so it is not proof of who is calling: that is what
    // INTERNAL_API_SECRET below is for.
    trustProxy: true,
    bodyLimit: 256 * 1024,
    /*
     * No "incoming request" / "request completed" pair per call.
     *
     * Two lines and a serialised request object for every request — including the
     * dashboard's polling reads — is most of this service's log volume and none of
     * its signal. What is worth knowing is still kept: errors log through the error
     * handler, refusals log where they are decided, and the slow-request hook below
     * reports the responses actually worth looking at.
     */
    disableRequestLogging: true,
  });

  /**
   * Only the slow ones.
   *
   * A request log nobody reads is noise, but silence hides the thing a log is for:
   * a read that has quietly grown to several seconds looks identical to a fast one
   * when nothing is recorded. So the ordinary traffic is silent and an outlier says
   * so, with the route pattern rather than the URL so ids don't fan it out.
   */
  const SLOW_REQUEST_MS = 2_000;

  app.addHook("onResponse", async (request, reply) => {
    const elapsed = reply.elapsedTime;
    if (elapsed < SLOW_REQUEST_MS) return;

    request.log.warn(
      {
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        statusCode: reply.statusCode,
        ms: Math.round(elapsed),
      },
      "slow response",
    );
  });

  await app.register(helmet, {
    // No browser ever renders a response from this service — it's a JSON API
    // consumed server-to-server — so the document-oriented directives are off
    // and the CSP that matters lives on the Next app.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  /**
   * Under the BFF the browser never calls this service, so CORS is a safety net
   * rather than a mechanism: allow only the Next origin, and only for the
   * non-credentialed preflight a stray direct call would trigger.
   */
  await app.register(cors, {
    origin: [env.WEB_ORIGIN],
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  /*
   * Rate limiting is applied per-route via the `rateLimit` preHandler in
   * `plugins/rate-limit.ts`, backed by `RateLimitStore` — an in-process counter
   * in every environment. That indirection stands in for `@fastify/rate-limit` so the
   * store can be swapped for a shared one without touching a route.
   */

  /**
   * The BFF→API hop, authenticated.
   *
   * Everything else in this service assumed "not reachable by browsers" was
   * enforced somewhere. It wasn't: the API answers anonymous public requests, and
   * CORS is not a control for a scripted client. Requiring a shared secret is what
   * makes the assumption true — and only then is `x-client-ip` worth reading, so
   * this hook is also what `clientIp` keys the rate limiter and the recorded
   * consent IP on.
   *
   * Registered after CORS so a preflight is still answered by the CORS hook, and
   * before the route plugins so no handler runs on an unauthenticated hop.
   */
  const internalSecret = env.INTERNAL_API_SECRET;

  app.addHook("onRequest", async (request) => {
    if (!internalSecret) {
      /*
       * Unset: treat every hop as the BFF, which is exactly what this service did
       * before the secret existed. Kept deliberately, so an existing deployment
       * whose client sends no secret behaves identically — the boot warning below
       * is the mitigation, not this branch.
       */
      request.internalHopVerified = true;
      return;
    }

    // The registered pattern where there is one; the raw URL only for a request
    // that matched no route, which is refused either way.
    const route = request.routeOptions?.url ?? request.url;
    if (INTERNAL_SECRET_EXEMPT_ROUTES.has(route)) return;

    if (!secretMatches(request.headers["x-internal-secret"], internalSecret)) {
      throw new AppError("unauthenticated", "Sign in to continue.");
    }

    request.internalHopVerified = true;
  });

  await app.register(authPlugin);
  registerErrorHandler(app);

  app.get("/healthz", async () => ({
    status: "ok",
    env: env.NODE_ENV,
    // Deliberately minimal: no version, no DB probe, nothing that tells an
    // unauthenticated caller about the deployment.
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(educatorApplicationRoutes, { prefix: "/educator-applications" });
  await app.register(educatorRoutes, { prefix: "/educators" });
  await app.register(staffRoutes, { prefix: "/staff" });
  await app.register(pricingRoutes, { prefix: "/pricing" });
  await app.register(bookingRoutes, { prefix: "/bookings" });
  await app.register(reviewRoutes, { prefix: "/reviews" });
  await app.register(contactRequestRoutes, { prefix: "/contact-requests" });
  await app.register(configRoutes, { prefix: "/config" });

  /**
   * Registered last and in its own encapsulated scope, because it replaces the
   * `application/json` parser with a raw-body one. Fastify scopes a content-type
   * parser to the plugin instance that adds it, so keeping this in a separate
   * `register` is what stops every other route from suddenly receiving a Buffer.
   *
   * Stripe calls this directly — not through the Next app. The URL to register in
   * the Stripe dashboard is `<this service's public origin>/stripe/webhook`.
   */
  await app.register(stripeWebhookRoutes, { prefix: "/stripe" });

  /*
   * A warning rather than a refusal, so existing deployments keep booting — but
   * loud, because without the secret every per-IP rate limit and every IP on a
   * consent or audit row is supplied by whoever is calling.
   */
  if (!internalSecret) {
    app.log.warn(
      "INTERNAL_API_SECRET is not set: this API accepts requests from anyone who " +
        "knows its URL, and trusts the caller's own x-client-ip — so credential " +
        "rate limits can be bypassed by rotating one header, and the IP recorded " +
        "on consent and audit rows is attacker-controlled. Set the same value here " +
        "and on the Next app.",
    );
  }

  if (!isProduction) {
    app.log.info({ webOrigin: env.WEB_ORIGIN }, "development configuration");
  }

  return app;
}
