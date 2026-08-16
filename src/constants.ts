/** Brand name, mirroring the client's `constants/site.ts`. */
export const SITE_NAME = "Your Learning Journey";

/**
 * Session lifetimes. Staff windows are deliberately short and ignore
 * remember-me: this platform has one `/login` for every role, so the protection a
 * separate staff route would give has to come from the role instead.
 */
export const SESSION_POLICY = {
  customer: {
    idleMinutes: 12 * 60,
    absoluteDays: 7,
    /** Remember-me extends the idle window and the absolute ceiling. */
    rememberMeIdleMinutes: 30 * 24 * 60,
    rememberMeAbsoluteDays: 30,
    allowRememberMe: true,
  },
  educator: {
    idleMinutes: 12 * 60,
    absoluteDays: 7,
    rememberMeIdleMinutes: 7 * 24 * 60,
    rememberMeAbsoluteDays: 14,
    allowRememberMe: true,
  },
  staff: {
    idleMinutes: 45,
    absoluteDays: 1,
    rememberMeIdleMinutes: 45,
    rememberMeAbsoluteDays: 1,
    allowRememberMe: false,
  },
} as const;

/** Single-use email token lifetimes. */
export const TOKEN_TTL = {
  emailVerificationHours: 24,
  passwordResetMinutes: 60,
  /** Long enough that an approved educator isn't locked out by a slow inbox. */
  inviteDays: 7,
} as const;

/**
 * Lockout thresholds. Applied per account, on top of the per-IP rate limit —
 * one without the other leaves either distributed guessing or a trivial
 * denial-of-service against a known email.
 */
export const LOCKOUT = {
  maxFailedAttempts: 8,
  lockMinutes: 15,
} as const;

/**
 * Booking policy — the launch defaults for what ARCHITECTURE.md §7 eventually
 * moves into the DB-backed `config_settings` namespace.
 *
 * **What is deliberately absent: prices.** Hourly rates, subject bands and the
 * in-home differential all live in the effective-dated tables behind
 * `services/pricing.service.ts`, and the quote engine reads them from there. A
 * second copy of the in-home multiplier here would be two sources of truth for a
 * number that appears on a card statement.
 *
 * What remains is policy the pricing tables don't express: the platform's cut,
 * the margin floor, and the timing rules the refund promise rests on.
 *
 * Every amount is integer cents. No float carries money in this service.
 */
export const BOOKING_POLICY = {
  /**
   * Platform take, in basis points. `educatorEarnings = total − round(total ×
   * bps / 10000)`, so the educator's share is a slice of the same gross and can
   * never exceed it — which makes a negative margin structurally impossible
   * rather than merely unlikely.
   */
  takeRateBps: 2500,

  /**
   * Stripe's own cut, estimated for the margin guard only. Never used for
   * accounting: the real fee arrives on the balance transaction and replaces it.
   */
  expectedStripeFeeBps: 290,
  expectedStripeFeeFlatCents: 30,

  /**
   * Refuse to issue a quote whose platform margin falls below this. Fail-closed:
   * a booking that loses money is not priced and not sold, rather than flagged
   * and sold anyway.
   */
  minMarginCents: 0,

  /** Quotes are short-lived so a price can't be held across a rate change. */
  quoteTtlMinutes: 15,

  /**
   * How long a Checkout Session stays payable. Stripe enforces it, and the exact
   * expiry comes back on the session — the responses carry that instant rather
   * than this number, so the payment page never has to estimate a deadline from
   * its own clock.
   */
  checkoutWindowMinutes: 30,

  /**
   * Days a coordinator has to confirm before the booking auto-refunds in full.
   * Surfaced to the parent *before* they pay, so the client's
   * `BOOKING_CONFIRMATION_SLA_DAYS` must agree with this number.
   */
  confirmationSlaDays: 2,

  /**
   * Minimum notice on a requested slot. A coordinator has to read the request,
   * reach the educator by phone and confirm — a session starting in three hours
   * cannot survive that, so it is refused rather than charged for.
   *
   * The client's `BOOKING_MIN_NOTICE_HOURS` greys out the same slots in the
   * calendar, so the two must agree. This one is the enforcement: a Server
   * Action is a public endpoint, and a browser rule is a courtesy.
   */
  minNoticeHours: 24,

  /**
   * How far ahead a session may be requested, in whole civil months: the window
   * runs to the end of the month this many months after the current one. Whole
   * months rather than a day count because that is what a calendar pages
   * through — it mirrors the client's `BOOKING_WINDOW_MONTHS`, so the server
   * never refuses a date the parent was offered.
   */
  bookingWindowMonths: 2,

  /** Full refund when a parent cancels at least this far ahead. */
  cancellationWindowHours: 24,

  /** No refund for a no-show. */
  noShowRefund: false,
} as const;

/**
 * What a stranger reads when a feature switch in site configuration is off.
 *
 * Written once because each is said by more than one entry point — a paused
 * platform has to refuse the quote *and* the booking, and a parent who sees two
 * different sentences for the same pause reasonably concludes something broke.
 * Deliberately a temporary-sounding closure with somewhere to go next: these are
 * switches an admin flips for an afternoon, not the platform shutting down.
 */
export const FLAG_MESSAGES = {
  bookingsPaused:
    "We've paused new bookings for a moment while we catch up. Please try again shortly, or send us a message and we'll arrange the session with you directly.",
  reviewsPaused:
    "We're not taking new reviews just now. Please try again in a little while — we'd still love to hear how it went.",
  applicationsClosed:
    "Educator applications are closed at the moment. Please check back soon; we reopen them as new subjects come up.",
} as const;
