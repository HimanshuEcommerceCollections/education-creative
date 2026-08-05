import { env } from "../../env.ts";
import { logger } from "../../lib/logger.ts";
import { ConsoleEmailDriver } from "./console-driver.ts";
import { ResendEmailDriver } from "./resend-driver.ts";
import type { EmailService } from "./types.ts";

export type { EmailMessage, EmailService } from "./types.ts";

function createEmailService(): EmailService {
  switch (env.EMAIL_DRIVER) {
    case "resend":
      // Non-null: env.ts already refused to boot without the key.
      return new ResendEmailDriver(env.RESEND_API_KEY!, env.EMAIL_FROM);
    case "smtp":
      // Deliberately not implemented yet rather than silently falling back to a
      // driver that sends nothing. Add nodemailer here when a QA inbox is set up.
      throw new Error(
        "EMAIL_DRIVER=smtp is declared but the driver is not implemented yet — " +
          "use `console` for local development or `resend` for a real send.",
      );
    case "console":
      return new ConsoleEmailDriver();
  }
}

export const emailService = createEmailService();

logger.info({ driver: emailService.name }, "email service ready");
