import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { ErrorResponse } from "../contracts/errors.ts";
import { isAppError } from "../lib/app-error.ts";
import { isProduction } from "../env.ts";

/**
 * Turns a Zod issue list into the `fieldErrors` map the auth forms render
 * inline. Only the first message per field survives — showing four complaints
 * about one input is noise.
 */
function fieldErrorsFromZod(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join(".");
    if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
  }
  return fieldErrors;
}

/**
 * The single place a failure becomes a response body. Every route throws;
 * nothing hand-rolls an error payload, so the envelope the client switches on
 * cannot drift between endpoints.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (isAppError(error)) {
      // Expected outcomes (bad password, used token) are info, not errors —
      // otherwise real faults drown in them.
      request.log.info(
        { code: error.code, ...error.logContext },
        `handled: ${error.message}`,
      );

      const body: ErrorResponse = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        },
      };
      return reply.status(error.statusCode).send(body);
    }

    if (error instanceof ZodError) {
      const body: ErrorResponse = {
        error: {
          code: "validation_failed",
          message: "Please check the highlighted fields.",
          fieldErrors: fieldErrorsFromZod(error),
        },
      };
      return reply.status(400).send(body);
    }

    // Fastify's own 4xx (malformed JSON, unsupported media type, rate limit).
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      const body: ErrorResponse = {
        error: {
          code: error.statusCode === 429 ? "rate_limited" : "validation_failed",
          message:
            error.statusCode === 429
              ? "Too many attempts. Please wait a moment and try again."
              : "That request wasn't valid.",
        },
      };
      return reply.status(error.statusCode).send(body);
    }

    request.log.error({ err: error }, "unhandled error");

    const body: ErrorResponse = {
      error: {
        code: "internal_error",
        // Never leak an exception message to the client in production; it can
        // carry SQL, paths, or column names.
        message: isProduction
          ? "Something went wrong on our end. Please try again."
          : `Unhandled: ${error.message}`,
      },
    };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorResponse = {
      error: { code: "not_found", message: "No such endpoint." },
    };
    return reply.status(404).send(body);
  });
}
