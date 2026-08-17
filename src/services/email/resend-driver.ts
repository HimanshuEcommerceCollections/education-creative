import { logger } from "../../lib/logger.ts";
import type { EmailMessage, EmailService } from "./types.ts";

/**
 * Production driver, hitting Resend's REST API directly rather than adding the
 * SDK — one POST is not worth a dependency, and it keeps the driver honest about
 * being replaceable.
 */
export class ResendEmailDriver implements EmailService {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: [message.replyTo] } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.error(
        { status: response.status, to: message.to, subject: message.subject },
        "resend send failed",
      );
      throw new Error(`Resend responded ${response.status}: ${detail.slice(0, 500)}`);
    }
  }
}
