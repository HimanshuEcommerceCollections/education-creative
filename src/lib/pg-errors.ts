/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

interface PgErrorLike {
  code?: unknown;
  constraint_name?: unknown;
}

/**
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose `cause` is the
 * postgres.js error carrying the SQLSTATE, and a pooled driver can nest one
 * further. Walking the chain is what makes this work — matching only the
 * top-level error silently misses every violation and turns an expected
 * "email already in use" into a 500.
 */
function findPgError(error: unknown, depth = 0): PgErrorLike | null {
  if (depth > 5 || typeof error !== "object" || error === null) return null;

  const candidate = error as PgErrorLike & { cause?: unknown };
  if (typeof candidate.code === "string") return candidate;

  return findPgError(candidate.cause, depth + 1);
}

/**
 * Detects a unique-constraint failure so a race between two concurrent signups
 * is reported as "email in use" rather than a 500. Relying on the index — not
 * only a pre-check — is what makes the guarantee real under concurrency.
 *
 * Pass `constraint` to match one specific index and let anything else propagate;
 * an unexpected unique violation is a bug and should not be reported as a
 * friendly field error.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = findPgError(error);
  if (!pgError || pgError.code !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return pgError.constraint_name === constraint;
}

/** The unique index behind case-insensitive email uniqueness on `users`. */
export const USERS_EMAIL_CONSTRAINT = "users_email_lower_key";
