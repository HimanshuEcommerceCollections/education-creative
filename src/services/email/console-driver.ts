import { appendFileSync } from "node:fs";

import { env } from "../../env.ts";
import { logger } from "../../lib/logger.ts";
import type { EmailMessage, EmailService } from "./types.ts";

/**
 * Development driver. Prints the message and pulls any link onto its own line, so
 * verification, reset, and invite flows can be completed locally by clicking the
 * terminal — no provider account, no inbox.
 *
 * `src/env.ts` rejects this driver in production.
 */
export class ConsoleEmailDriver implements EmailService {
  readonly name = "console";

  async send(message: EmailMessage): Promise<void> {
    const links = message.text.match(/https?:\/\/\S+/g) ?? [];

    logger.info(
      { to: message.to, subject: message.subject },
      "email (console driver — not actually sent)",
    );
    // Deliberately console, not the logger: pino-pretty would escape the newlines
    // and make the link unclickable in most terminals.
    console.log(
      [
        "",
        "──────────────────────────────────────────────────────────",
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        "──────────────────────────────────────────────────────────",
        message.text,
        ...(links.length > 0 ? ["", "  Link(s):", ...links.map((l) => `  → ${l}`)] : []),
        "──────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );

    this.appendToOutbox(message, links);
  }

  /**
   * Appends each message to `EMAIL_OUTBOX_FILE` as one JSON line, when that's set.
   *
   * This exists because the e2e scripts need the single-use tokens that only ever
   * appear in an email, and scraping the API's redirected stdout for them proved
   * unreliable — the driver's `console.log` and pino's transport don't reliably
   * land in the same redirected file. A synchronous append to a dedicated path has
   * no such ambiguity.
   *
   * Never enable this outside development: it writes live tokens to disk in
   * plaintext.
   */
  private appendToOutbox(message: EmailMessage, links: string[]): void {
    if (!env.EMAIL_OUTBOX_FILE) return;

    try {
      appendFileSync(
        env.EMAIL_OUTBOX_FILE,
        `${JSON.stringify({
          at: new Date().toISOString(),
          to: message.to,
          subject: message.subject,
          links,
          text: message.text,
        })}\n`,
        "utf8",
      );
    } catch (error) {
      // A broken test seam must never break the request it observes.
      logger.warn({ err: error }, "could not append to EMAIL_OUTBOX_FILE");
    }
  }
}
