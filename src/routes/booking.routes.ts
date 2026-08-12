import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  cannotConfirmBookingSchema,
  confirmBookingSchema,
  createBookingRequestSchema,
  quoteRequestSchema,
  refundBookingSchema,
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
import {
  cannotConfirmBooking,
  confirmBooking,
  getBookingChildDetails,
  listAssignableEducators,
  listBookingQueue,
  listEducatorAssignments,
  listParentBookings,
  refundBooking,
  sweepUnconfirmedBookings,
} from "../services/booking-ops.service.ts";
import { createQuote } from "../services/quote.service.ts";

const idParamsSchema = z.object({ id: z.uuid() });

/** Which slice of the queue staff asked for. Defaults to what needs deciding. */
const queueQuerySchema = z.object({
  status: z
    .enum([
      "paid_unconfirmed",
      "confirmed",
      "partially_refunded",
      "refunded",
      "completed",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

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

  /**
   * The parent's own history. Static path, so it never collides with `/:id`.
   */
  app.get("/mine", { preHandler: [requireParent] }, async (request) => {
    const items = await listParentBookings(request.principal!);
    return { items };
  });

  /**
   * The educator's confirmed assignments. Scoping is in the service, keyed off
   * the session's own educator profile — this endpoint takes no educator
   * parameter at all, so there is nothing to tamper with to read someone else's.
   */
  app.get(
    "/assigned",
    { preHandler: [app.requireRole("educator")] },
    async (request) => {
      const items = await listEducatorAssignments(request.principal!);
      return { items };
    },
  );

  // -------------------------------------------------------------------------
  // Coordinator surface (§5: coordinators run operations)
  // -------------------------------------------------------------------------

  /**
   * The confirmation queue. Both staff roles work it.
   *
   * `educators` rides along because the only reason to ask "who may I assign?" is
   * that you are looking at a booking — a second endpoint would be a second round
   * trip for one screen.
   */
  app.get("/queue", { preHandler: [app.requireStaff] }, async (request) => {
    const query = queueQuerySchema.parse(request.query);
    const [items, educators] = await Promise.all([
      listBookingQueue({
        statuses: query.status ? [query.status] : undefined,
        limit: query.limit,
      }),
      listAssignableEducators(),
    ]);
    return { items, educators };
  });

  /**
   * Learner details and the in-home address, for whoever legitimately needs
   * them: staff working the booking, or the approved educator it is assigned to.
   * Every call is audited, which is why this is a separate request rather than
   * fields on the list above.
   *
   * `authenticate` rather than a role guard — this is the one endpoint two
   * different roles reach for different reasons, so *which* of them may see
   * *this* booking is decided in the service, against the booking itself.
   */
  app.get("/:id/child-details", { preHandler: [app.authenticate] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return getBookingChildDetails(id, request.principal!, requestContext(request));
  });

  /** Assign one approved educator and confirm. */
  app.post("/:id/confirm", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = confirmBookingSchema.parse(request.body);
    const result = await confirmBooking(
      id,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message: `${result.reference} confirmed with ${result.educatorName}.`,
      ...result,
    };
  });

  /**
   * Can't fulfil it — refund in full. Payments must be configured, since this
   * reaches Stripe; refusing early gives a usable message instead of a 500 from
   * a missing key.
   */
  app.post(
    "/:id/cannot-confirm",
    { preHandler: [app.requireStaff] },
    async (request) => {
      assertPaymentsAvailable();
      const { id } = idParamsSchema.parse(request.params);
      const input = cannotConfirmBookingSchema.parse(request.body);
      const result = await cannotConfirmBooking(
        id,
        input,
        request.principal!,
        requestContext(request),
      );
      return {
        message: `${result.reference} refunded in full.`,
        ...result,
      };
    },
  );

  /**
   * A discretionary refund, whole or partial — the conflict path.
   *
   * Open to both staff roles: the *amount* is what separates them, and the
   * coordinator cap is enforced in the service against the booking's refund
   * history, not by which role can reach this route.
   */
  app.post("/:id/refund", { preHandler: [app.requireStaff] }, async (request) => {
    assertPaymentsAvailable();
    const { id } = idParamsSchema.parse(request.params);
    const input = refundBookingSchema.parse(request.body);
    const result = await refundBooking(
      id,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message:
        result.remainingCents > 0
          ? `Refunded on ${result.reference}. ${(result.remainingCents / 100).toFixed(2)} still refundable.`
          : `${result.reference} is now fully refunded.`,
      ...result,
    };
  });

  /**
   * Runs the SLA auto-refund sweep once.
   *
   * Admin-only and idempotent: a booking already refunded is no longer
   * `paid_unconfirmed`, so a second call finds nothing. Exposed as an endpoint so
   * a scheduler (or `npm run bookings:sweep`) can drive it without this repo
   * having to host a job runner yet — the sweep itself is the launch-blocking
   * part, not what triggers it.
   */
  app.post(
    "/sweep-unconfirmed",
    { preHandler: [app.requireRole("admin")] },
    async (request) => {
      assertPaymentsAvailable();
      const result = await sweepUnconfirmedBookings(requestContext(request));
      return {
        message:
          result.sweptIds.length === 0
            ? "Nothing was past its confirmation deadline."
            : `Refunded ${result.sweptIds.length} booking(s) past the confirmation deadline.`,
        ...result,
      };
    },
  );
}
