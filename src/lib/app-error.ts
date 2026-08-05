import { type ErrorCode, statusForCode } from "../contracts/errors.ts";

/**
 * The only error type routes should throw. Carries the contract's error code, so
 * the global handler can derive the HTTP status and body without every route
 * assembling its own envelope.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly fieldErrors?: Record<string, string>;
  /** Context for the log line only — never serialised to the client. */
  readonly logContext?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      fieldErrors?: Record<string, string>;
      logContext?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusForCode(code);
    this.fieldErrors = options?.fieldErrors;
    this.logContext = options?.logContext;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Deliberately identical for "no such email", "wrong password", and "account has
 * no password set" — anything more specific is a user-enumeration oracle.
 */
export function invalidCredentials(): AppError {
  return new AppError("invalid_credentials", "That email or password isn't right.");
}
