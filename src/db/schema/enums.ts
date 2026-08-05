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
