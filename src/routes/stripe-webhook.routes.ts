import type { FastifyInstance } from "fastify";

import { AppError } from "../lib/app-error.ts";
import { isStripeConfigured } from "../lib/stripe.ts";
import {
  constructEvent,
  handleStripeEvent,
} from "../services/stripe-webhook.service.ts";

/**
 * `POST /stripe/webhook` — the only source of payment truth.
 *
 * Three things make this route unlike every other one in the service:
 *
 * 1. **It is unauthenticated**, because Stripe has no session. The signature *is*
 *    the authentication, and it is checked before the body is looked at.
 * 2. **It needs the raw bytes.** Signature verification runs over the exact body
 *    Stripe sent, so a JSON parse-and-restringify breaks it — hence the
 *    route-scoped content-type parser below rather than Fastify's default.
 * 3. **Stripe calls it directly**, not through the Next app. Routing webhooks via
 *    Vercel would put a serverless function between Stripe and the raw body, and
 *    is a large part of why this service is a long-lived Node process at all.
 *
 * On a shared Stripe account this endpoint receives other projects' events too.
 * They are filtered by project tag inside `handleStripeEvent` before any handler
 * runs — see `lib/stripe.ts`.
 */
export async function stripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  /*
   * Raw body, scoped to this plugin instance. `application/json` is re-registered
   * here so only webhook requests skip JSON parsing — every other route keeps the
   * parsed body it expects.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post("/webhook", async (request, reply) => {
    if (!isStripeConfigured()) {
      // 503 rather than 404: the endpoint exists, this deployment just has no
      // Stripe configured. Distinguishable in the dashboard's delivery log.
      return reply.status(503).send({ received: false, reason: "stripe_not_configured" });
    }

    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string") {
      throw new AppError("validation_failed", "Missing Stripe signature.");
    }

    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new AppError("validation_failed", "Expected a raw body.");
    }

    let event;
    try {
      event = constructEvent(rawBody, signature);
    } catch (error) {
      /*
       * A bad signature is not a payment event — it is someone probing, or a
       * mismatched signing secret. 400 tells Stripe not to retry, and the log line
       * is the first place to look when a freshly rotated secret breaks delivery.
       */
      request.log.warn(
        { err: error },
        "rejected Stripe webhook: signature verification failed",
      );
      return reply.status(400).send({ received: false, reason: "invalid_signature" });
    }

    try {
      const handled = await handleStripeEvent(event);
      // 200 acknowledges receipt whether or not this project acted on it. A
      // filtered sibling-project event is correctly handled by ignoring it, and
      // must not make Stripe retry forever.
      return reply.status(200).send({ received: true, handled });
    } catch (error) {
      /*
       * 500 so Stripe retries with backoff. The event row already records the
       * failure, so a webhook that keeps failing is visible in our own data rather
       * than only in Stripe's delivery log.
       */
      request.log.error(
        { err: error, eventId: event.id, type: event.type },
        "Stripe webhook handler failed",
      );
      return reply.status(500).send({ received: false });
    }
  });
}
