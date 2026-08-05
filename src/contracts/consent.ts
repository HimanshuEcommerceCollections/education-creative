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
} as const;

export type ConsentTextVersion = keyof typeof CONSENT_TEXTS;

/** The version captured by the signup form today. */
export const CURRENT_SIGNUP_CONSENT_VERSION: ConsentTextVersion = "signup-guardian-v1";

export const CURRENT_SIGNUP_CONSENT_TEXT =
  CONSENT_TEXTS[CURRENT_SIGNUP_CONSENT_VERSION];
