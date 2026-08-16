export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text is always provided; HTML is optional per-template. */
  text: string;
  html?: string;
  /**
   * Where a reply should land. Set centrally from `EMAIL_REPLY_TO`, because
   * several templates tell the recipient to reply — an expiring invite says so as
   * its only recovery route — and `EMAIL_FROM` is typically a no-reply sender
   * that silently discards them.
   */
  replyTo?: string;
}

/**
 * The one interface business logic may depend on. Drivers are selected by
 * `EMAIL_DRIVER`, so no route or service ever names a provider — moving between
 * Gmail SMTP, Resend, and AWS SES is a config change, not a code change.
 *
 * Adding a provider means one new file implementing this and one case in the
 * factory. Nothing else in the codebase should need to know it exists.
 */
export interface EmailService {
  readonly name: string;

  send(message: EmailMessage): Promise<void>;

  /**
   * Optional connectivity and credential check that sends nothing. Implemented
   * where the provider supports it, so `npm run email:test` can distinguish
   * "credentials are wrong" from "the message was rejected".
   */
  verify?(): Promise<void>;

  /** Optional cleanup — SMTP holds a connection pool worth closing on shutdown. */
  close?(): Promise<void>;
}
