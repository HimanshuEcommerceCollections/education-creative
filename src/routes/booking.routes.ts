import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  bookingOutcomeSchema,
  bookingStatusSchema,
  cancelBookingSchema,
  cannotConfirmBookingSchema,
  confirmBookingSchema,
  createBookingRequestSchema,
  quoteRequestSchema,
  reassignBookingSchema,
  refundBookingSchema,
  rescheduleBookingSchema,
} from "../contracts/bookings.ts";
import { env } from "../env.ts";
import { AppError } from "../lib/app-error.ts";
import { isStripeConfigured } from "../lib/stripe.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  createBooking,
  getBookingStatus,
  requireCustomerProfileId,
  resumeBookingCheckout,
} from "../services/booking.service.ts";
import {
  cancelBookingByParent,
  cannotConfirmBooking,
  confirmBooking,
  countBookingsByStatus,
  getBookingChildDetails,
  listAssignableEducators,
  listBookingQueue,
  listEducatorAssignments,
  listParentBookings,
  reassignBooking,
  recordBookingOutcome,
  refundBooking,
  rescheduleBooking,
  sweepUnconfirmedBookings,
} from "../services/booking-ops.service.ts";
import { createQuote } from "../services/quote.service.ts";

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Which slice of the queue staff asked for. **Every** status, and omitting it
 * means all of them.
 *
 * The short list this replaced left `disputed`, `expired`, `pending_payment` and
 * `no_show` unrequestable, so an open chargeback — the one state that hard-locks
 * refunds and puts an educator's earnings at risk — appeared on no screen in the
 * product and was refused with a validation error when the dashboard asked for it.
 */
const queueQuerySchema = z.object({
  status: bookingStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
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

  /**
   * Refuses early and clearly when Stripe isn't configured for this deployment.
   *
   * `isStripeConfigured` is the one answer to that question — it checks all four
   * STRIPE_* variables, where the local copy this replaced checked two, so a
   * deployment missing only the publishable key or the project tag showed a
   * working pay button and failed at Checkout.
   */
  function assertPaymentsAvailable(): void {
    if (!isStripeConfigured()) {
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
   * A fresh client secret for a booking abandoned at the payment step.
   *
   * Rate-limited on its own budget rather than sharing the booking one: the whole
   * point is that a parent retrying a payment shouldn't burn the allowance that
   * stops them creating ten bookings an hour.
   */
  app.post(
    "/:id/checkout",
    {
      preHandler: [
        requireParent,
        rateLimit({ max: 20, windowSeconds: 60 * 60, scope: "booking-checkout" }),
      ],
    },
    async (request) => {
      assertPaymentsAvailable();
      const { id } = idParamsSchema.parse(request.params);
      return resumeBookingCheckout(id, request.principal!);
    },
  );

  /**
   * The parent cancels their own session.
   *
   * Ownership is checked in the service against the booking's own
   * `customer_profiles` row, not from anything in the request — the id in the path
   * is the only parameter, and it is not trusted to belong to the caller.
   */
  app.post("/:id/cancel", { preHandler: [requireParent] }, async (request) => {
    assertPaymentsAvailable();
    const { id } = idParamsSchema.parse(request.params);
    const input = cancelBookingSchema.parse(request.body ?? {});
    const result = await cancelBookingByParent(
      id,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message: `${result.reference} is cancelled and refunded in full.`,
      ...result,
    };
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
    const [items, educators, counts] = await Promise.all([
      listBookingQueue({
        statuses: query.status ? [query.status] : undefined,
        limit: query.limit,
      }),
      listAssignableEducators(),
      /*
       * Counted over every booking, never over the page. The dashboard filters
       * the returned rows into tabs, so a count taken from `items` would silently
       * become "how many of the first 200", and a tab reading zero because the
       * page ran out is the same lie as a tab that can't be opened at all.
       */
      countBookingsByStatus(),
    ]);
    return { items, educators, counts };
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
   * The session moves to a new time.
   *
   * No `assertPaymentsAvailable`, unlike the refund paths: nothing here reaches
   * Stripe. The amount, the status and the SLA deadline are all untouched — only
   * the day and time the family and the educator are holding.
   */
  app.post("/:id/reschedule", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = rescheduleBookingSchema.parse(request.body);
    const result = await rescheduleBooking(
      id,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message: `${result.reference} moved to ${result.preferredDate} at ${result.preferredTime}.`,
      ...result,
    };
  });

  /** A different approved educator takes a confirmed session. */
  app.post("/:id/reassign", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = reassignBookingSchema.parse(request.body);
    const result = await reassignBooking(
      id,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message: result.previousEducatorName
        ? `${result.reference} moved from ${result.previousEducatorName} to ${result.educatorName}.`
        : `${result.reference} assigned to ${result.educatorName}.`,
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
   * What happened on the day: `completed` or `no_show`.
   *
   * `authenticate` rather than a role guard, like `child-details`: staff *or* the
   * educator the booking was assigned to may record it, and which of them this
   * caller is has to be decided against the booking itself. This is the only
   * writer of `completedAt`, so without it the state machine dead-ends at
   * `confirmed`. Every outcome is audited with the actor who recorded it.
   */
  app.post("/:id/outcome", { preHandler: [app.authenticate] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = bookingOutcomeSchema.parse(request.body);
    const result = await recordBookingOutcome(
      id,
      input,
      request.principal!,
      requestContext(request),
    );
    return {
      message:
        result.status === "completed"
          ? `${result.reference} is recorded as completed.`
          : `${result.reference} is recorded as a no-show.`,
      ...result,
    };
  });

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

  /** What the sweep did, in one sentence for whoever triggered it. */
  function sweepMessage(result: {
    sweptIds: string[];
    failed: { id: string }[];
    remaining: number;
  }): string {
    const parts: string[] = [
      result.sweptIds.length === 0
        ? "Nothing was past its confirmation deadline."
        : `Refunded ${result.sweptIds.length} booking(s) past the confirmation deadline.`,
    ];
    // Failures and leftovers are money still held past our own promise, so they
    // are stated rather than left to be inferred from an array length.
    if (result.failed.length > 0) {
      parts.push(`${result.failed.length} could not be refunded.`);
    }
    if (result.remaining > 0) {
      parts.push(`${result.remaining} more are still due and were not reached.`);
    }
    return parts.join(" ");
  }

  /**
   * Runs the SLA auto-refund sweep once.
   *
   * Admin-only and idempotent: a booking already refunded is no longer due, so a
   * second call finds nothing. Kept alongside the cron route below for a human
   * who wants to run it now, and used by `npm run bookings:sweep`.
   */
  app.post(
    "/sweep-unconfirmed",
    { preHandler: [app.requireRole("admin")] },
    async (request) => {
      assertPaymentsAvailable();
      const result = await sweepUnconfirmedBookings(requestContext(request));
      return { message: sweepMessage(result), ...result };
    },
  );

  /**
   * The scheduled SLA auto-refund sweep.
   *
   * **This is what makes the refund promise real.** Charging before anyone has
   * agreed to teach is only defensible because the money comes back automatically at
   * the deadline, so the sweep has to be on a timer — one that runs when a human
   * remembers to is not a guarantee.
   *
   * `GET`, because that is the only method Vercel Cron issues, and a bearer secret
   * rather than a session, because a timer has no user. Registered daily in
   * `vercel.json`.
   *
   * A missing or wrong secret answers **404**, not 401: a 401 confirms the route
   * is there, and this one moves real money with no human in the loop. Compared in
   * constant time so the response can't be used to guess the secret a character at
   * a time.
   */
  app.get("/cron/sweep-unconfirmed", async (request) => {
    if (!isCronRequest(request)) {
      throw new AppError("not_found", "Not found.");
    }

    assertPaymentsAvailable();
    const result = await sweepUnconfirmedBookings({
      ...requestContext(request),
      // The sweep's refunds are attributed to no person, and the request id is
      // what ties a log line to the audit rows a run produced.
      requestId: `cron:sweep-unconfirmed:${request.id}`,
    });

    return { message: sweepMessage(result), ...result };
  });
}

/**
 * Whether a request carries the cron secret. Fails closed when `CRON_SECRET` is
 * unset, so a deployment that forgot it has no open endpoint — the sweep is then
 * simply unscheduled, which is visible, rather than callable by anyone.
 */
function isCronRequest(request: FastifyRequest): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;

  const offered = Buffer.from(header.slice("Bearer ".length).trim());
  const expected = Buffer.from(secret);

  // `timingSafeEqual` throws on a length mismatch, which is itself a length
  // oracle — but the length of a secret is not the secret.
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}
