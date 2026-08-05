/**
 * Checks the configured email provider without touching the database.
 *
 * Two stages, so a failure tells you *which* thing is wrong:
 *   1. verify() — opens a connection and authenticates, sending nothing.
 *   2. send()   — delivers a real message to an address you name.
 *
 *   npm run email:test                      # verify only
 *   npm run email:test -- you@example.com   # verify, then send
 */
import { emailService } from "../src/services/email/index.ts";
import { env } from "../src/env.ts";
import { logger } from "../src/lib/logger.ts";

const recipient = process.argv[2];

/**
 * Turns a provider error into something actionable. These four failures account
 * for nearly every first-time setup problem, and their raw messages are all
 * misleading in the same way — they describe the symptom, not the cause.
 */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;

  if (/invalid login|username and password not accepted|BadCredentials/i.test(message)) {
    return [
      "Authentication was rejected.",
      "  For Gmail, SMTP_PASSWORD must be a 16-character App Password — not your",
      "  account password — and the account needs 2-Step Verification enabled.",
      "  Create one at https://myaccount.google.com/apppasswords",
    ].join("\n");
  }

  if (code === "ETIMEDOUT" || code === "ESOCKET" || /timed?\s?out/i.test(message)) {
    return [
      "The connection timed out.",
      `  Outbound port ${env.SMTP_PORT} is probably blocked. Many hosts block SMTP`,
      "  (25/465/587) to deter spam. Switch to EMAIL_DRIVER=resend or ses, which",
      "  use HTTPS on 443 — same EmailService, no code changes.",
    ].join("\n");
  }

  if (/not verified|MessageRejected/i.test(message)) {
    return [
      "The provider rejected the sender or recipient.",
      "  SES sandbox: both addresses must be verified until you request production",
      "  access. Resend free tier: you can only send to your own account address",
      "  until a sending domain is verified.",
    ].join("\n");
  }

  if (/self.signed|certificate/i.test(message)) {
    return [
      "TLS negotiation failed.",
      "  Check SMTP_PORT and SMTP_SECURE agree: 465 needs SMTP_SECURE=true,",
      "  587 needs SMTP_SECURE=false.",
    ].join("\n");
  }

  return message;
}

logger.info({ driver: emailService.name, from: env.EMAIL_FROM }, "testing email provider");

if (typeof emailService.verify === "function") {
  try {
    await emailService.verify();
    console.log(`\nPASS  ${emailService.name}: credentials accepted, connection open`);
  } catch (error) {
    console.error(`\nFAIL  ${emailService.name}: could not authenticate\n\n  ${explain(error)}\n`);
    await emailService.close?.();
    process.exit(1);
  }
} else {
  console.log(
    `\nnote  the ${emailService.name} driver has no verify step — sending is the only check`,
  );
}

if (!recipient) {
  console.log("\nPass an address to send a real test message:");
  console.log("  npm run email:test -- you@example.com\n");
  await emailService.close?.();
  process.exit(0);
}

try {
  await emailService.send({
    to: recipient,
    subject: "Test message from Your Learning Journey",
    text: [
      "This is a test of the platform's email configuration.",
      "",
      `  driver: ${emailService.name}`,
      `  from:   ${env.EMAIL_FROM}`,
      "",
      "If you received this, verification emails, password resets, and educator",
      "invites will all reach their recipients.",
    ].join("\n"),
  });
  console.log(`PASS  ${emailService.name}: message accepted for ${recipient}`);
  console.log("\n  Check the inbox — and the spam folder, which is where a new");
  console.log("  sending identity usually lands first.\n");
} catch (error) {
  console.error(`FAIL  ${emailService.name}: send rejected\n\n  ${explain(error)}\n`);
  await emailService.close?.();
  process.exit(1);
}

await emailService.close?.();
