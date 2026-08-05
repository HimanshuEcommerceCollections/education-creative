import { logger } from "../../lib/logger.ts";
import type { EmailMessage, EmailService } from "./types.ts";

/**
 * Development driver. Prints the message and pulls any link out onto its own
 * line so verification, reset, and invite flows can be completed locally by
 * clicking the terminal — no provider account, no inbox.
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
    // Deliberately console, not the logger: pino-pretty would escape the
    // newlines and make the link unclickable in most terminals.
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
  }
}
