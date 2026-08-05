import { z } from "zod";

import { userRoleSchema } from "./roles.ts";

/**
 * Minimum password length. Both the signup form and the API read this constant,
 * so the client can never accept a password the server will reject. Raised from
 * the demo form's 6.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  // Argon2id has no practical input ceiling, but an unbounded body is a cheap
  // way to burn CPU, so cap it.
  .max(PASSWORD_MAX_LENGTH, "That password is too long.");

/**
 * Emails are lowercased and trimmed here, once, so every downstream comparison
 * and the `lower(email)` unique index agree.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address."));

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, "Enter your name.")
  .max(120, "That name is too long.");

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.");

// ---------------------------------------------------------------------------
// Signup — customers only. Educators apply; staff are invited.
// ---------------------------------------------------------------------------

export const signupRequestSchema = z
  .object({
    fullName: fullNameSchema,
    email: emailSchema,
    password: passwordSchema,
    /**
     * The guardian consent checkbox. A literal `true` rather than a boolean so
     * an absent or false value is a validation error, not a silent skip — this
     * is the COPPA consent gate.
     */
    consentGiven: z.literal(true, {
      message: "Please confirm you're the parent or guardian.",
    }),
    /** Optional subject chips. Slugs, deduped, capped to keep the row sane. */
    subjectsOfInterest: z.array(z.string().trim().min(1)).max(20).default([]),
    phone: z.string().trim().max(40).optional(),
  })
  .strict();

export type SignupRequest = z.infer<typeof signupRequestSchema>;

// ---------------------------------------------------------------------------
// Login — one endpoint for all four roles.
// ---------------------------------------------------------------------------

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    // Not `passwordSchema`: an existing password shorter than the current
    // minimum must still be able to sign in (and then be prompted to change).
    password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
    /** Ignored for staff — see `sessionPolicyFor`. */
    rememberMe: z.boolean().default(false),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * What login resolved to. A staff account always lands on `mfa_enrolment` or
 * `mfa_required` first; the session cookie is set in every case but is inert
 * until MFA is satisfied.
 */
export const loginOutcomeSchema = z.enum([
  "authenticated",
  "mfa_required",
  "mfa_enrolment_required",
]);

export type LoginOutcome = z.infer<typeof loginOutcomeSchema>;

/**
 * Where a staff login goes before it can do anything. Shared with the client so
 * the routes and the server's `redirectTo` can't disagree.
 */
export const MFA_VERIFY_PATH = "/login/mfa";
export const MFA_SETUP_PATH = "/login/mfa/setup";

export const loginResponseSchema = z.object({
  outcome: loginOutcomeSchema,
  /** Opaque session token — the BFF stores this in an HttpOnly cookie. */
  token: z.string(),
  expiresAt: z.iso.datetime(),
  /** Server-computed destination. The browser never derives this itself. */
  redirectTo: z.string(),
  session: z.lazy(() => sessionResponseSchema),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

// ---------------------------------------------------------------------------
// Session introspection — the only thing the BFF trusts.
// ---------------------------------------------------------------------------

export const sessionResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.email(),
    fullName: z.string(),
    emailVerified: z.boolean(),
  }),
  roles: z.array(userRoleSchema),
  activeRole: userRoleSchema,
  isStaff: z.boolean(),
  /** False on a staff session that has not cleared TOTP yet. */
  mfaSatisfied: z.boolean(),
  mfaEnrolled: z.boolean(),
  /** True once every precondition for acting as `activeRole` is met. */
  fullyAuthenticated: z.boolean(),
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

// ---------------------------------------------------------------------------
// Staff TOTP
// ---------------------------------------------------------------------------

export const mfaSetupResponseSchema = z.object({
  /** `otpauth://` URI for the authenticator app / QR code. */
  uri: z.string(),
  /** Shown for manual entry when a camera isn't available. */
  secret: z.string(),
});

export const mfaVerifyRequestSchema = z.object({ code: totpCodeSchema }).strict();

export const mfaEnrolRequestSchema = z.object({ code: totpCodeSchema }).strict();

// ---------------------------------------------------------------------------
// Email verification, password reset, invite acceptance
// ---------------------------------------------------------------------------

export const tokenSchema = z.string().trim().min(20).max(200);

export const verifyEmailRequestSchema = z.object({ token: tokenSchema }).strict();

/** `GET /auth/invite?token=…` — reads an invite without consuming it. */
export const inviteTokenQuerySchema = z.object({ token: tokenSchema }).strict();

export const resendVerificationRequestSchema = z
  .object({ email: emailSchema })
  .strict();

export const forgotPasswordRequestSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordRequestSchema = z
  .object({ token: tokenSchema, password: passwordSchema })
  .strict();

/**
 * Shared by educator and staff invites — both were created by someone else and
 * are choosing their first password. The age-gate attestation is captured here
 * because it was never captured at signup for these accounts.
 */
export const acceptInviteRequestSchema = z
  .object({
    token: tokenSchema,
    password: passwordSchema,
    attestAdult: z.literal(true, { message: "Please confirm you're over 18." }),
  })
  .strict();

export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;
export type MfaSetupResponse = z.infer<typeof mfaSetupResponseSchema>;

/** Read before showing the set-password form, so it can greet them by name. */
export const inviteDetailsResponseSchema = z.object({
  email: z.email(),
  fullName: z.string(),
  role: userRoleSchema,
  expiresAt: z.iso.datetime(),
});

export const messageResponseSchema = z.object({ message: z.string() });
