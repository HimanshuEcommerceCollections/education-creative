/** Brand name, mirroring the client's `constants/site.ts`. */
export const SITE_NAME = "Your Learning Journey";

/**
 * Session lifetimes. Staff windows are deliberately short and ignore
 * remember-me: this platform has one `/login` for every role, so the protection
 * that used to come from a separate staff route has to come from the role.
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
   * Days a coordinator has to confirm before the booking auto-refunds in full.
   * Surfaced to the parent *before* they pay, so the client's
   * `BOOKING_CONFIRMATION_SLA_DAYS` must agree with this number.
   */
  confirmationSlaDays: 2,

  /** Full refund when a parent cancels at least this far ahead. */
  cancellationWindowHours: 24,

  /** No refund for a no-show. */
  noShowRefund: false,
} as const;
