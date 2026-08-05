import { logger } from "../../lib/logger.ts";
import type { EmailMessage, EmailService } from "./types.ts";

export interface SesConfig {
  region: string;
  from: string;
  /** Omit both to fall back to the ambient AWS credential chain (IAM role). */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Optional configuration set, for per-stream event tracking. */
  configurationSetName?: string;
}

/**
 * AWS SES over the **HTTPS API**, not SES's SMTP interface.
 *
 * That choice matters operationally: several hosts block outbound SMTP ports
 * (25/465/587) to deter spam, which is exactly the wall that makes Gmail SMTP
 * undeployable on some platforms. An HTTPS call on 443 is never blocked, so this
 * driver is the one that keeps working wherever the service ends up.
 */
export class SesEmailDriver implements EmailService {
  readonly name = "ses";

  private client: unknown = null;

  constructor(private readonly config: SesConfig) {}

  /** The AWS SDK is heavy, so it loads only when this driver is selected. */
  private async getClient() {
    if (this.client) return this.client as import("@aws-sdk/client-sesv2").SESv2Client;

    const { SESv2Client } = await import("@aws-sdk/client-sesv2");
    this.client = new SESv2Client({
      region: this.config.region,
      // Explicit keys when given; otherwise the default provider chain picks up
      // an instance/task IAM role, which is preferable in production.
      ...(this.config.accessKeyId && this.config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: this.config.accessKeyId,
              secretAccessKey: this.config.secretAccessKey,
            },
          }
        : {}),
    });

    return this.client as import("@aws-sdk/client-sesv2").SESv2Client;
  }

  async send(message: EmailMessage): Promise<void> {
    const client = await this.getClient();
    const { SendEmailCommand } = await import("@aws-sdk/client-sesv2");

    try {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: this.config.from,
          Destination: { ToAddresses: [message.to] },
          ...(this.config.configurationSetName
            ? { ConfigurationSetName: this.config.configurationSetName }
            : {}),
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: message.text, Charset: "UTF-8" },
                ...(message.html
                  ? { Html: { Data: message.html, Charset: "UTF-8" } }
                  : {}),
              },
            },
          },
        }),
      );
    } catch (error) {
      logger.error(
        { err: error, to: message.to, subject: message.subject, region: this.config.region },
        "ses send failed",
      );
      throw error;
    }
  }

  /**
   * Confirms credentials and region by reading the account's send quota — a
   * read-only call, so it can't accidentally email anyone.
   */
  async verify(): Promise<void> {
    const client = await this.getClient();
    const { GetAccountCommand } = await import("@aws-sdk/client-sesv2");
    const account = await client.send(new GetAccountCommand({}));

    if (account.ProductionAccessEnabled === false) {
      logger.warn(
        "SES account is still in the sandbox — you can only send to verified addresses. " +
          "Request production access before real signups.",
      );
    }
  }
}
