/**
 * Canonical consent copy. The server hashes **this** text, never text sent by
 * the browser — a client-supplied string would make the consent record prove
 * nothing. The client renders the same constant so the wording shown and the
 * wording recorded cannot drift.
 *
 * Editing copy means adding a new version, not changing an existing one; old
 * records must keep pointing at the exact words their user agreed to.
 */
export const CONSENT_TEXTS = {
  "signup-guardian-v1":
    "I'm a parent or guardian creating this account for my family, and I'll book and supervise every session.",
  /**
   * Captured on the booking form, at the moment a child's first name and age
   * band are first entered — which is what the COPPA basis rests on. It cannot
   * move to checkout: the data is collected before payment, and a comp or $0
   * booking has no payment to attach it to.
   */
  "learner-data-v1":
    "I agree to Your Learning Journey storing my child's first name, age range, and learning notes so an educator can prepare for the session. I understand I can delete this at any time.",
  /**
   * Reaffirms guardianship for a specific booking. Separate from the signup
   * consent because it is per-session — the parent is confirming they'll be
   * present for *this* session, which is the promise the safety model relies on.
   */
  "booking-guardian-v1":
    "I confirm I'm the parent or guardian booking this session, and that an adult will be present and supervising throughout.",
} as const;

export type ConsentTextVersion = keyof typeof CONSENT_TEXTS;

/** The version captured by the signup form today. */
export const CURRENT_SIGNUP_CONSENT_VERSION: ConsentTextVersion = "signup-guardian-v1";

export const CURRENT_SIGNUP_CONSENT_TEXT =
  CONSENT_TEXTS[CURRENT_SIGNUP_CONSENT_VERSION];

/** The versions captured by the booking form today. */
export const CURRENT_LEARNER_CONSENT_VERSION: ConsentTextVersion = "learner-data-v1";

export const CURRENT_LEARNER_CONSENT_TEXT =
  CONSENT_TEXTS[CURRENT_LEARNER_CONSENT_VERSION];

export const CURRENT_BOOKING_GUARDIAN_CONSENT_VERSION: ConsentTextVersion =
  "booking-guardian-v1";

export const CURRENT_BOOKING_GUARDIAN_CONSENT_TEXT =
  CONSENT_TEXTS[CURRENT_BOOKING_GUARDIAN_CONSENT_VERSION];
