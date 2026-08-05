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
