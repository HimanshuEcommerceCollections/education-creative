import { pino } from "pino";

import { env, isDevelopment } from "../env.ts";

/**
 * Paths scrubbed from every log line. Tokens and child PII must never be
 * persisted to logs (§9 of the architecture doc) — redaction lives here rather
 * than at each call site so a new route can't forget it.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.body.password",
  "req.body.newPassword",
  "req.body.currentPassword",
  "req.body.token",
  "req.body.totpCode",
  "password",
  "passwordHash",
  "token",
  "tokenHash",
  "sessionToken",
  "mfaSecret",
  "totpCode",
  "firstName",
  "inHomeAddress",
];

const BASE_OPTIONS = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
};

/**
 * Human-readable logs are for a terminal, and only when the transport can
 * actually work.
 *
 * `pino-pretty` runs as a worker thread that resolves its target by module name at
 * runtime. That resolution fails inside a bundled serverless function — the module
 * isn't there to find — and pino throws while *constructing the logger*, which
 * takes the whole process down before any route is reached. It crashed every
 * request on Vercel with "unable to determine transport target for pino-pretty".
 *
 * So: skip it on a serverless platform, and treat a failure to build the pretty
 * logger as a reason to fall back to JSON rather than to die. A logger must never
 * be the thing that breaks the service.
 */
function createLogger() {
  const wantsPretty = isDevelopment && !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (wantsPretty) {
    try {
      return pino({
        ...BASE_OPTIONS,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      });
    } catch {
      // Fall through to structured JSON, which needs no transport.
    }
  }

  return pino(BASE_OPTIONS);
}

export const logger = createLogger();
