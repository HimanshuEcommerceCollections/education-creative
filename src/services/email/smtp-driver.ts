import type { Transporter } from "nodemailer";

import { logger } from "../../lib/logger.ts";
import type { EmailMessage, EmailService } from "./types.ts";

export interface SmtpConfig {
  host: string;
  port: number;
  /** True for implicit TLS (port 465); false for STARTTLS (587). */
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

/**
 * Generic SMTP driver. Despite the name this is not Gmail-specific — the same
 * driver serves Gmail, AWS SES's SMTP interface, Mailgun, Brevo, Postmark, and a
 * local Mailpit, because they all speak SMTP. Only the four connection settings
 * change.
 *
 * The transporter is created once and reused: nodemailer pools connections, and
 * re-authenticating per message is both slow and a fast route to a provider
 * rate-limiting you.
 */
export class SmtpEmailDriver implements EmailService {
  readonly name = "smtp";

  private transporter: Transporter | null = null;

  constructor(private readonly config: SmtpConfig) {}

  /**
   * `nodemailer` is imported lazily so a deployment using Resend or SES never
   * pays for loading it.
   */
  private async getTransporter(): Promise<Transporter> {
    if (this.transporter) return this.transporter;

    const nodemailer = await import("nodemailer");
    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      pool: true,
      maxConnections: 3,
      // Gmail throttles aggressively on bursts; keep concurrency modest.
      maxMessages: 50,
      /*
       * Explicit, short timeouts. Nodemailer's defaults are minutes long, and a
       * host that blocks outbound SMTP doesn't refuse the connection — it drops
       * the packets, so the socket hangs rather than erroring. Left at the
       * defaults, that turns into a request hanging until the platform's own
       * function timeout kills it. Ten seconds is far more than a reachable
       * server needs and fails fast when the port is blocked.
       */
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });

    return this.transporter;
  }

  async send(message: EmailMessage): Promise<void> {
    const transporter = await this.getTransporter();

    try {
      await transporter.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
    } catch (error) {
      // The message and subject are safe to log; the body may contain a
      // single-use token, so it is never included.
      logger.error(
        { err: error, to: message.to, subject: message.subject, host: this.config.host },
        "smtp send failed",
      );
      throw error;
    }
  }

  /**
   * Opens a connection and authenticates without sending anything. Used by the
   * `email:test` script so a bad app password surfaces immediately rather than at
   * the moment a real user tries to sign up.
   */
  async verify(): Promise<void> {
    const transporter = await this.getTransporter();
    await transporter.verify();
  }

  async close(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
  }
}
