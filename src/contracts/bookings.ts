/**
 * Booking request contract — the shape a parent's booking form submits and the
 * API validates. One definition, enforced on both sides.
 *
 * The model this encodes (ARCHITECTURE.md §8, locked): the parent **pays at the
 * time of booking**, a **coordinator then confirms** and assigns an educator,
 * and only then does the session reach the educator. Two consequences run
 * through the field names:
 *
 * 1. Everything the parent chooses about *who* and *when* is a **request**, not
 *    a reservation — `educatorSlug` is who they'd like, `preferredDate` /
 *    `preferredTime` are when they'd like it. Nothing is held. At launch the
 *    coordinator is the conflict check (materialised availability slots and the
 *    overlap constraint are a deferred fast-follow), so honest naming here is
 *    what keeps the UI copy honest too.
 * 2. No money crosses this boundary. There is deliberately no `total` field —
 *    the amount is computed server-side from the quote (§7) and never accepted
 *    from a client. The browser may render an estimate; it may not name a price.
 *
 * Learner details are collected here, before payment, which is exactly why the
 * `learner_data` consent is part of *this* request rather than the checkout: the
 * COPPA basis requires consent captured at the moment child data is first
 * entered (§4).
 */

import { z } from "zod";

/**
 * Where the session happens. `in_home` additionally requires an address, which
 * is why the two are an enum rather than a boolean — the address rule below
 * hangs off this value.
 */
export const BOOKING_FORMATS = ["in_home", "online"] as const;
export const bookingFormatSchema = z.enum(BOOKING_FORMATS);
export type BookingFormat = (typeof BOOKING_FORMATS)[number];

/** Bookable session lengths, in minutes. */
export const SESSION_DURATIONS = [60, 90, 120] as const;
export type SessionDuration = (typeof SESSION_DURATIONS)[number];

export const sessionDurationSchema = z.union([
  z.literal(60),
  z.literal(90),
  z.literal(120),
]);

/**
 * Age bands rather than dates of birth. A band is enough for an educator to
 * pitch a session, and it is the least child data the flow can function on —
 * data we don't collect is data we can't leak or have to delete.
 */
export const LEARNER_AGE_BANDS = ["4-6", "7-9", "10-12", "13-15", "16-18"] as const;
export const learnerAgeBandSchema = z.enum(LEARNER_AGE_BANDS);
export type LearnerAgeBand = (typeof LEARNER_AGE_BANDS)[number];

/**
 * The single timezone the platform operates in. Every `preferredDate` and
 * `preferredTime` below is a *civil* date and time in this zone — never a UTC
 * instant — so a parent in Raleigh and a coordinator on a laptop set to UTC read
 * the same 4:00 PM.
 */
export const BOOKING_TIMEZONE = "America/New_York";

/** `YYYY-MM-DD`, a civil date in `BOOKING_TIMEZONE`. */
export const civilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date for the session.");

/** `HH:MM` on a 24-hour clock, a civil time in `BOOKING_TIMEZONE`. */
export const civilTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time for the session.");

/**
 * What we keep about the child. `firstName` only: the profile exists so an
 * educator knows who they're teaching, and a surname adds identifiability
 * without adding usefulness.
 */
export const learnerSchema = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1, "Tell us your child's first name.")
      .max(60, "That's longer than we can store."),
    ageBand: learnerAgeBandSchema,
    /** Optional free text: what they're working on, what to know up front. */
    focus: z.string().trim().max(600, "Please keep this under 600 characters.").optional(),
  })
  .strict();

export type LearnerInput = z.infer<typeof learnerSchema>;

/**
 * The booking parent. Present even for a signed-in parent, because the account
 * holder and the person who'll be home for the session can differ, and the
 * phone number is per-booking contact detail rather than account data.
 */
export const bookingContactSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, "Please enter your full name.")
      .max(120, "That's longer than we can store."),
    email: z.email("Please enter a valid email address."),
    phone: z
      .string()
      .trim()
      .min(7, "Please enter a phone number we can reach you on.")
      .max(40, "That's longer than we can store."),
  })
  .strict();

/**
 * In-home address. Collected before payment because it drives the travel
 * component of the quote (§7), and encrypted at rest because of who it belongs
 * to — it is released to an educator only once the booking is confirmed *and*
 * every assigned educator holds a current, approved background check (§5).
 */
export const bookingAddressSchema = z
  .object({
    line1: z.string().trim().min(1, "Please enter the street address.").max(160),
    line2: z.string().trim().max(160).optional(),
    city: z.string().trim().min(1, "Please enter the city.").max(80),
    state: z.string().trim().min(2, "Please enter the state.").max(40),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, "Please enter a valid ZIP code."),
    /** Gate codes, parking, which door — practical, not sensitive. */
    notes: z.string().trim().max(300).optional(),
  })
  .strict();

export type BookingAddressInput = z.infer<typeof bookingAddressSchema>;

/**
 * What the pricing engine needs and nothing else. Split out from the booking
 * request so the form can re-quote as the parent changes format or length,
 * without having entered a single child detail yet.
 */
export const quoteRequestSchema = z
  .object({
    educatorSlug: z.string().trim().min(1).max(60),
    /**
     * The **priced** subject: one of the platform's six categories (`music`,
     * `tutoring`, …). Rates and bands hang off this, so it is what the pricing
     * engine resolves against.
     */
    subjectSlug: z.string().trim().min(1).max(80),
    /**
     * The **chosen** subject, as the parent picked it — "Piano", "Algebra I & II".
     * Free text on the educator's profile rather than a table, per §7's split
     * between priced categories and taught topics. It reaches the educator; it
     * never reaches the pricing engine.
     */
    subjectTopic: z.string().trim().min(1).max(80),
    format: bookingFormatSchema,
    durationMinutes: sessionDurationSchema,
    /** Only the ZIP, because travel pricing is all the address affects here. */
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/)
      .optional(),
  })
  .strict();

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

/** One line of the price breakdown, in integer cents. */
export const quoteLineItemSchema = z.object({
  label: z.string(),
  amountCents: z.number().int(),
});

/**
 * The server's authoritative price. Immutable and short-lived: booking creation
 * re-validates the quote and derives the payment amount from it, so a stale or
 * tampered figure can't become a charge.
 *
 * Note what is absent — the take-rate split, the educator's earnings, and the
 * platform margin are computed alongside this and recorded on the booking, but
 * never serialised to a parent.
 */
export const quoteResponseSchema = z.object({
  id: z.string(),
  currency: z.string(),
  lineItems: z.array(quoteLineItemSchema),
  totalCents: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
});

export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

/**
 * `POST /bookings`. Creates the booking in `pending_payment` and returns what
 * the browser needs to mount checkout — never a completed booking, because
 * payment truth arrives by webhook, not by this response.
 */
export const createBookingRequestSchema = z
  .object({
    /** The educator the parent would like. A request; a coordinator confirms. */
    educatorSlug: z.string().trim().min(1).max(60),
    /** Priced category — see `quoteRequestSchema`. */
    subjectSlug: z.string().trim().min(1, "Choose what your child is learning.").max(80),
    /** Chosen topic — see `quoteRequestSchema`. */
    subjectTopic: z
      .string()
      .trim()
      .min(1, "Choose what your child is learning.")
      .max(80),
    format: bookingFormatSchema,
    durationMinutes: sessionDurationSchema,

    preferredDate: civilDateSchema,
    preferredTime: civilTimeSchema,
    /**
     * A second choice, and `flexibleTime` for "any of your open times". Both
     * exist to cut the coordinator's back-and-forth: nothing is reserved at
     * launch, so a single fixed request that can't be met costs an email round
     * trip that a stated alternative avoids.
     */
    alternateTime: civilTimeSchema.optional(),
    flexibleTime: z.boolean().default(false),

    learner: learnerSchema,
    contact: bookingContactSchema,
    address: bookingAddressSchema.optional(),

    /**
     * The quote being paid. Optional so a caller may ask the server to price the
     * booking fresh; when supplied it is re-validated (active, unexpired, same
     * client, same inputs) and never trusted as a number.
     */
    quoteId: z.string().max(80).optional(),

    /**
     * Consent for entering a child's details, captured *here* because this
     * request is the moment that data is first collected (§4). `literal(true)`
     * rather than `boolean` so an unchecked box is a validation error with the
     * right message, not a silently-false record.
     */
    learnerDataConsentGiven: z.literal(true, {
      message: "Please confirm you agree to us storing your child's details.",
    }),
    /** Reaffirms guardianship and supervision for this specific booking. */
    guardianConfirmed: z.literal(true, {
      message: "Please confirm you're the parent or guardian and will supervise.",
    }),
  })
  .strict()
  .superRefine((value, ctx) => {
    // An in-home session with no address can't be dispatched or priced for
    // travel, so the address is conditionally required rather than optional.
    if (value.format === "in_home" && !value.address) {
      ctx.addIssue({
        code: "custom",
        path: ["address", "line1"],
        message: "Add the address for the in-home session.",
      });
    }
    // An online session has no address to hold, so refuse rather than store one.
    if (value.format === "online" && value.address) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "An online session doesn't need an address.",
      });
    }
    if (value.alternateTime && value.alternateTime === value.preferredTime) {
      ctx.addIssue({
        code: "custom",
        path: ["alternateTime"],
        message: "Choose a different time as your second choice.",
      });
    }
  });

export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;

/**
 * `POST /bookings` response. `status` is the booking's own state machine value,
 * and it is `pending_payment` here by construction — nothing in this response
 * may be read as "paid".
 */
export const createBookingResponseSchema = z.object({
  bookingId: z.string(),
  reference: z.string(),
  status: z.literal("pending_payment"),
  quote: quoteResponseSchema,
  /**
   * Stripe Embedded Checkout client secret. Publishable-key material, safe to
   * hand the browser; the amount behind it came from the re-validated quote.
   */
  checkoutClientSecret: z.string(),
  /**
   * The publishable key for the account that issued that client secret.
   *
   * Returned with the session rather than configured separately in the Next app
   * so the two cannot disagree. A publishable key from a different account than
   * the session fails to mount with an error that says nothing useful, and on a
   * shared Stripe estate that mismatch is easy to create and miserable to
   * diagnose.
   */
  publishableKey: z.string(),
});

export type CreateBookingResponse = z.infer<typeof createBookingResponseSchema>;

/**
 * `GET /bookings/:id` — what the browser polls after Checkout reports complete.
 *
 * Payment truth arrives by webhook, so the browser learning "Stripe says done"
 * is not the same as the booking being paid. This endpoint is how the page waits
 * for the webhook to land, and `paymentPending` is the honest answer while it
 * hasn't: money taken, our side not yet updated.
 */
export const bookingStatusResponseSchema = z.object({
  bookingId: z.string(),
  reference: z.string(),
  status: z.enum([
    "pending_payment",
    "paid_unconfirmed",
    "confirmed",
    "completed",
    "no_show",
    "refunded",
    "partially_refunded",
    "disputed",
    "expired",
  ]),
  /** True while Stripe has taken payment but no webhook has been processed. */
  paymentPending: z.boolean(),
  totalCents: z.number().int(),
  currency: z.string(),
  /** When the auto-refund fires if no coordinator confirms. */
  slaDeadline: z.iso.datetime().nullable(),
});

export type BookingStatusResponse = z.infer<typeof bookingStatusResponseSchema>;
