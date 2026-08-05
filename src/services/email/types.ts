export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text is always provided; HTML is optional per-template. */
  text: string;
  html?: string;
}

/**
 * The one interface business logic may depend on. Drivers are selected by
 * `EMAIL_DRIVER`, so no route or service ever names a provider — swapping
 * Resend for SES is a config change (§3).
 */
export interface EmailService {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
