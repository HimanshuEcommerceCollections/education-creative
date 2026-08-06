import { env } from "../../env.ts";
import { logger } from "../../lib/logger.ts";
import { ConsoleEmailDriver } from "./console-driver.ts";
import { ResendEmailDriver } from "./resend-driver.ts";
import { SesEmailDriver } from "./ses-driver.ts";
import { SmtpEmailDriver } from "./smtp-driver.ts";
import type { EmailService } from "./types.ts";

export type { EmailMessage, EmailService } from "./types.ts";

/**
 * Builds the configured driver. `env.ts` has already validated that the settings
 * each provider needs are present, so nothing here has to defend against a
 * half-configured provider — a missing key fails at boot, not at the moment a
 * parent tries to verify their email.
 *
 * Every driver's SDK is imported lazily inside the driver itself, so selecting
 * Gmail doesn't load the AWS SDK and vice versa.
 */
function createEmailService(): EmailService {
  switch (env.EMAIL_DRIVER) {
    case "smtp":
      return new SmtpEmailDriver({
        host: env.SMTP_HOST!,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER!,
        password: env.SMTP_PASSWORD!,
        from: env.EMAIL_FROM,
      });

    case "resend":
      return new ResendEmailDriver(env.RESEND_API_KEY!, env.EMAIL_FROM);

    case "ses":
      return new SesEmailDriver({
        region: env.AWS_REGION!,
        from: env.EMAIL_FROM,
        ...(env.AWS_ACCESS_KEY_ID ? { accessKeyId: env.AWS_ACCESS_KEY_ID } : {}),
        ...(env.AWS_SECRET_ACCESS_KEY
          ? { secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : {}),
        ...(env.SES_CONFIGURATION_SET
          ? { configurationSetName: env.SES_CONFIGURATION_SET }
          : {}),
      });

    case "console":
      return new ConsoleEmailDriver();
  }
}

export const emailService = createEmailService();

/**
 * Hard ceiling on how long a send may delay the request that triggered it.
 *
 * The SMTP driver already sets per-stage timeouts, but those bound each stage, not
 * the total — a black-holed port measured at 21s end to end, which is both a
 * dreadful signup experience and close enough to a platform function limit to risk
 * being killed mid-request. This bounds it regardless of what any driver does.
 */
const SEND_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`email send exceeded ${ms}ms`)),
      ms,
    );
    // The underlying send is abandoned, not cancelled — it may still complete in
    // the background, which is harmless: the worst case is a duplicate message.
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Sends without ever throwing. Returns whether it got through.
 *
 * Every send in a request path uses this. A provider failure must not fail the
 * request that triggered it: by the time an email goes out the transaction has
 * committed, so throwing would return a 500 for an account that *was* created —
 * and the user then can't retry, because their address is already taken. Worse on
 * a host that blocks SMTP, where the failure is a connection timeout: the caller
 * waits for the timeout and then gets an error, on every single signup.
 *
 * The logged context is deliberately enough to identify who missed which message,
 * without recording the body — that contains single-use tokens. Recovery is the
 * resend paths (`/auth/resend-verification`, `/auth/forgot-password`); a durable
 * outbox with retries belongs with pg-boss.
 */
export async function trySend(
  message: Parameters<EmailService["send"]>[0],
  context: { purpose: string; userId?: string },
): Promise<boolean> {
  try {
    await withTimeout(emailService.send(message), SEND_TIMEOUT_MS);
    return true;
  } catch (error) {
    logger.error(
      {
        err: error,
        driver: emailService.name,
        to: message.to,
        purpose: context.purpose,
        userId: context.userId,
      },
      "email send failed — the request still succeeded, so the recipient needs a resend",
    );
    return false;
  }
}

logger.info(
  {
    driver: emailService.name,
    ...(env.EMAIL_DRIVER === "smtp" ? { host: env.SMTP_HOST, port: env.SMTP_PORT } : {}),
    ...(env.EMAIL_DRIVER === "ses" ? { region: env.AWS_REGION } : {}),
  },
  "email service ready",
);
