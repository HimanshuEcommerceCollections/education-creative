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

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  ...(isDevelopment
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});
