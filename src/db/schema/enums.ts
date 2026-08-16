import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Canonical enums. These are frozen — they're referenced by the shared
 * contracts the Next app imports, so renaming a value is a migration plus a
 * client change, not a rename.
 *
 * `customer` is this project's name for what ARCHITECTURE.md §5 calls `client`
 * (renamed to avoid colliding with the `client/` frontend directory).
 * `guest` is deliberately absent: it is the absence of a session, not a row.
 */
export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "coordinator",
  "educator",
  "customer",
]);

/**
 * `invited` covers an account created by approval or staff invite whose owner
 * has not yet set a password — it cannot authenticate until they do.
 */
export const userStatusEnum = pgEnum("user_status", [
  "invited",
  "active",
  "suspended",
  "deactivated",
]);

export const authProviderEnum = pgEnum("auth_provider", ["password", "google"]);

export const emailTokenPurposeEnum = pgEnum("email_token_purpose", [
  "email_verification",
  "password_reset",
  "invite",
]);

/**
 * `signup_guardian` is the consent captured at customer signup (the checkbox
 * copy in `SIGNUP_CONSENT`). `learner_data` is captured later, at the moment a
 * parent first enters a child's details — before collection, per §4.
 */
export const consentTypeEnum = pgEnum("consent_type", [
  "signup_guardian",
  "learner_data",
]);

export const educatorApplicationStatusEnum = pgEnum("educator_application_status", [
  "submitted",
  "in_review",
  "approved",
  "rejected",
]);

export const educatorVerificationStatusEnum = pgEnum("educator_verification_status", [
  "draft",
  "pending",
  "approved",
  "suspended",
]);

/** Where a session happens. Mirrors the contract's `BOOKING_FORMATS`. */
export const bookingFormatEnum = pgEnum("booking_format", ["in_home", "online"]);

/**
 * The booking state machine (ARCHITECTURE.md §8).
 *
 * `paid_unconfirmed` is the state the locked flow revolves around: money is
 * captured and nobody has committed to delivering the session yet. Only a
 * coordinator moves it to `confirmed`, and only after every assigned educator is
 * background-approved.
 */
export const bookingStatusEnum = pgEnum("booking_status", [
  "pending_payment",
  "paid_unconfirmed",
  "confirmed",
  "completed",
  "no_show",
  "refunded",
  "partially_refunded",
  "disputed",
  "expired",
]);

/** Payment state, tracking Stripe's own vocabulary. */
export const paymentStatusEnum = pgEnum("payment_status", [
  "requires_payment",
  "processing",
  "succeeded",
  "refunded",
  "partially_refunded",
  "failed",
  "canceled",
  "disputed",
]);

/** Learner age bands. Mirrors the contract's `LEARNER_AGE_BANDS`. */
export const learnerAgeBandEnum = pgEnum("learner_age_band", [
  "4-6",
  "7-9",
  "10-12",
  "13-15",
  "16-18",
]);

/** Append-only ledger accounts. */
export const ledgerAccountEnum = pgEnum("ledger_account", [
  "platform_revenue",
  "educator_earnings_accrued",
  "stripe_fee",
  "refund",
  "dispute",
]);

/**
 * `accrued` becomes `at_risk` on a dispute and `reversed` on a loss. Educator
 * earnings are held rather than paid out until the settlement window passes,
 * because a chargeback can land months after the session.
 */
export const ledgerStatusEnum = pgEnum("ledger_status", [
  "accrued",
  "at_risk",
  "reversed",
]);

/**
 * A review is invisible until a human publishes it. `rejected` is kept rather than
 * deleted so a parent can't be told twice to write one, and so a moderation
 * decision stays auditable.
 */
export const reviewStatusEnum = pgEnum("review_status", [
  "pending",
  "published",
  "rejected",
]);

/** Why someone wrote in. Mirrors the four options the contact form offers. */
export const contactReasonEnum = pgEnum("contact_reason", [
  "finding_educator",
  "pricing",
  "booking_help",
  "other",
]);

/**
 * `spam` is a terminal side exit rather than a delete: a public form attracts
 * junk, and burying it keeps the abuse signal (and the address that sent it)
 * without it sitting in the queue someone is trying to work.
 */
export const contactRequestStatusEnum = pgEnum("contact_request_status", [
  "new",
  "in_progress",
  "resolved",
  "spam",
]);
