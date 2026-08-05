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

logger.info(
  {
    driver: emailService.name,
    ...(env.EMAIL_DRIVER === "smtp" ? { host: env.SMTP_HOST, port: env.SMTP_PORT } : {}),
    ...(env.EMAIL_DRIVER === "ses" ? { region: env.AWS_REGION } : {}),
  },
  "email service ready",
);
