import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createBookingRequestSchema,
  quoteRequestSchema,
} from "../contracts/bookings.ts";
import { AppError } from "../lib/app-error.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  createBooking,
  getBookingStatus,
  paymentsConfigured,
  requireCustomerProfileId,
} from "../services/booking.service.ts";
import { createQuote } from "../services/quote.service.ts";

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Parent-facing booking endpoints.
 *
 * Every route is gated on the `customer` role, not merely a valid session: a
 * booking belongs to a parent's `customer_profiles` row, and an educator or staff
 * session has none. Enforced here rather than in the UI — the disabled pay button
 * in the client is a courtesy, this is the boundary.
 *
 * Note what is absent: any endpoint that accepts an amount, and any endpoint that
 * marks a booking paid. Prices come from the pricing engine; payment truth comes
 * from the webhook.
 */
export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  const requireParent = app.requireRole("customer");

  /** Refuses early and clearly when Stripe isn't configured for this deployment. */
  function assertPaymentsAvailable(): void {
    if (!paymentsConfigured()) {
      throw new AppError(
        "conflict",
        "Card payment isn't available yet. Please contact us and we'll arrange your session directly.",
        { logContext: { reason: "stripe_not_configured" } },
      );
    }
  }

  /**
   * Prices a session without creating anything. The booking form calls this as a
   * parent changes format or length, so the figure they see before paying is the
   * server's, not the browser's estimate.
   */
  app.post(
    "/quotes",
    {
      preHandler: [
        requireParent,
        rateLimit({ max: 60, windowSeconds: 60 * 10, scope: "quote" }),
      ],
    },
    async (request) => {
      const input = quoteRequestSchema.parse(request.body);
      const customerProfileId = await requireCustomerProfileId(request.principal!.userId);
      return createQuote(customerProfileId, input);
    },
  );

  /**
   * Creates the booking and opens a Checkout Session.
   *
   * A verified email is required. It gates the *first* booking in the product
   * copy, and it is checked on every one here: an unverified address is one we
   * cannot send a receipt, a confirmation, or a refund notice to, which makes it
   * unfit to take money against.
   */
  app.post(
    "/",
    {
      preHandler: [
        requireParent,
        rateLimit({ max: 10, windowSeconds: 60 * 60, scope: "booking" }),
      ],
    },
    async (request, reply) => {
      assertPaymentsAvailable();

      const input = createBookingRequestSchema.parse(request.body);
      const principal = request.principal!;

      if (!principal.emailVerifiedAt) {
        throw new AppError(
          "email_not_verified",
          "Please confirm your email address before your first booking.",
        );
      }

      const result = await createBooking(input, principal, requestContext(request));
      return reply.status(201).send(result);
    },
  );

  /**
   * The booking's status, for the page polling after Checkout reports complete.
   *
   * This is how the browser waits for the webhook rather than trusting itself: it
   * returns `pending_payment` with `paymentPending: true` until a signed event has
   * actually moved the booking.
   */
  app.get("/:id", { preHandler: [requireParent] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return getBookingStatus(id, request.principal!);
  });
}
