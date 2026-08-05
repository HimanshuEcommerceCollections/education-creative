import { z } from "zod";

/**
 * Machine-readable failure codes. The Next layer switches on these rather than
 * matching message strings, so copy can change without breaking behaviour.
 */
export const ERROR_CODES = [
  "validation_failed",
  "invalid_credentials",
  "account_locked",
  "account_inactive",
  /** Password accepted, but the staff second factor is still outstanding. */
  "mfa_required",
  "mfa_invalid",
  "email_in_use",
  "email_not_verified",
  "invalid_token",
  "token_expired",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * The single failure envelope every endpoint returns. `fieldErrors` is keyed by
 * form field name so the auth forms can render messages inline instead of the
 * booleans they use today.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    fieldErrors: z.record(z.string(), z.string()).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 400,
  invalid_credentials: 401,
  account_locked: 423,
  account_inactive: 403,
  mfa_required: 401,
  mfa_invalid: 401,
  email_in_use: 409,
  email_not_verified: 403,
  invalid_token: 400,
  token_expired: 410,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
