import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import { env, isProduction } from "./env.ts";
import { logger } from "./lib/logger.ts";
import { authPlugin } from "./plugins/authenticate.ts";
import { registerErrorHandler } from "./plugins/error-handler.ts";
import { authRoutes } from "./routes/auth.routes.ts";
import { educatorApplicationRoutes } from "./routes/educator-application.routes.ts";
import { staffRoutes } from "./routes/staff.routes.ts";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Widened to Fastify's own logger interface. Passing the concrete pino type
    // would specialise `FastifyInstance`'s generics, and every route module's
    // plain `FastifyInstance` parameter would then stop matching.
    loggerInstance: logger as FastifyBaseLogger,
    // Vercel's platform sets these; the API is not browser-reachable, so the
    // forwarding chain is trusted.
    trustProxy: true,
    bodyLimit: 256 * 1024,
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
   * in every environment. `@fastify/rate-limit` was replaced by that indirection
   * so the store can be swapped for a shared one without touching a route.
   */

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
  await app.register(staffRoutes, { prefix: "/staff" });

  if (!isProduction) {
    app.log.info({ webOrigin: env.WEB_ORIGIN }, "development configuration");
  }

  return app;
}
