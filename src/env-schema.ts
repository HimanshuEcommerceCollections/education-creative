import { z } from "zod";

/**
 * The environment contract, separated from `env.ts` so it can be validated
 * against synthetic inputs without `env.ts`'s import-time side effects (reading
 * `.env`, and exiting the process when it's invalid).
 */

/** 32 raw bytes, base64-encoded, as `randomBytes(32).toString("base64")` gives. */
const base64Key32 = z
  .string()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "must be exactly 32 bytes, base64-encoded",
  });

/**
 * An optional setting that tolerates being present-but-blank.
 *
 * This matters because `.env.example` lists every provider's keys with empty
 * values, and a plain `.optional()` would reject `RESEND_API_KEY=` outright —
 * `""` is present, so `.min(1)` fires. Anyone who copied the template and filled
 * in only the provider they use could not boot.
 */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** Generic so the inner schema's output type flows through the preprocess. */
function optionalText<T extends z.ZodType>(inner: T) {
  return z.preprocess(blankToUndefined, inner.optional());
}

/** The common case: a non-empty string, or absent. */
const optionalString = () => optionalText(z.string().min(1));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /**
     * Set by Vercel to "production" | "preview" | "development" for the
     * deployment itself. Read so the guards below can't be switched off by a
     * mis-set NODE_ENV — see `isProductionLike`.
     */
    VERCEL_ENV: optionalString(),
    VERCEL: optionalString(),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: z.string().startsWith("postgres"),
    WEB_ORIGIN: z.url(),

    SESSION_PEPPER: z.string().min(32),
    FIELD_ENCRYPTION_KEY: base64Key32,

    /**
     * Which `EmailService` driver to construct. Business logic never names a
     * provider, so switching is a config change only.
     *   console — prints to stdout; development default, rejected in production
     *   smtp    — Gmail, SES-over-SMTP, Mailgun, Brevo, Postmark, Mailpit
     *   resend  — HTTPS API
     *   ses     — AWS SES over the HTTPS API (no SMTP ports)
     */
    EMAIL_DRIVER: z.enum(["console", "smtp", "resend", "ses"]).default("console"),
    EMAIL_FROM: z.string().min(3),
    /**
     * Development only. When set, the console driver appends every message to
     * this path as JSONL so the e2e scripts can read the single-use tokens that
     * exist nowhere else. Writes live tokens in plaintext, so production boot
     * rejects it.
     */
    EMAIL_OUTBOX_FILE: optionalString(),

    // --- smtp -------------------------------------------------------------
    SMTP_HOST: optionalString(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    /** Implicit TLS (465). Leave false for STARTTLS (587). */
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USER: optionalString(),
    /**
     * Google displays app passwords in groups of four ("abcd efgh ijkl mnop"),
     * and pasting that verbatim fails with a misleading "username and password
     * not accepted". Whitespace is stripped so either form works.
     */
    SMTP_PASSWORD: optionalText(
      z
        .string()
        .min(1)
        .transform((value) => value.replace(/\s+/g, "")),
    ),

    // --- resend -----------------------------------------------------------
    RESEND_API_KEY: optionalString(),

    // --- ses --------------------------------------------------------------
    AWS_REGION: optionalString(),
    /** Omit both keys to use the ambient IAM role instead. */
    AWS_ACCESS_KEY_ID: optionalString(),
    AWS_SECRET_ACCESS_KEY: optionalString(),
    SES_CONFIGURATION_SET: optionalString(),

    // --- stripe -----------------------------------------------------------
    /**
     * Secret key. `sk_` for a full key, `rk_` for a restricted one — prefer a
     * restricted key scoped to Checkout Sessions, PaymentIntents, Refunds and
     * Events write/read, since nothing here needs the rest of the account.
     */
    STRIPE_SECRET_KEY: optionalText(
      z.string().regex(/^(sk|rk)_(test|live)_/, "must start with sk_ or rk_"),
    ),
    /** Signing secret for the endpoint registered in the Stripe dashboard. */
    STRIPE_WEBHOOK_SECRET: optionalText(
      z.string().startsWith("whsec_", "must start with whsec_"),
    ),
    /**
     * Publishable key. Held here so the API can hand it to the browser alongside
     * a Checkout Session's client secret — one source of truth for which Stripe
     * account is in play, rather than a second copy the two halves can disagree on.
     */
    STRIPE_PUBLISHABLE_KEY: optionalText(
      z.string().regex(/^pk_(test|live)_/, "must start with pk_test_ or pk_live_"),
    ),
    /**
     * **Which project owns an object in a shared Stripe account.**
     *
     * This is not a label — it is a safety mechanism. A Stripe account delivers
     * every event of a subscribed type to *every* registered webhook endpoint,
     * regardless of which integration created the object. So if this project and
     * another share an account, this project's endpoint receives the other's
     * `payment_intent.succeeded` too.
     *
     * That is actively dangerous here: the rule for "a succeeded PaymentIntent
     * with no matching local booking" is to refund it (§8). Unfiltered, this
     * service would refund another project's revenue, correctly and immediately.
     *
     * So every object we create carries `metadata.project = STRIPE_PROJECT_KEY`,
     * and the webhook drops anything that doesn't match before any handler sees
     * it. Two projects must never share a value.
     *
     * A separate Stripe account (or at least a separate sandbox) per project is
     * still the better answer — see the note in `lib/stripe.ts`.
     */
    STRIPE_PROJECT_KEY: optionalText(
      z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9_-]{1,31}$/,
          "lowercase letters, digits, dash and underscore; 2-32 characters",
        ),
    ),

    SEED_ADMIN_EMAIL: optionalText(z.email()),
    SEED_ADMIN_PASSWORD: optionalString(),
    SEED_ADMIN_NAME: optionalString(),
  })
  // Fail-closed on the combinations that would otherwise blow up at the moment
  // an email is first sent, or quietly ship a development-only setting.
  .superRefine((env, ctx) => {
    const required = (key: keyof typeof env, message: string) => {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message });
    };

    if (env.EMAIL_DRIVER === "smtp") {
      required("SMTP_HOST", "required when EMAIL_DRIVER=smtp (Gmail: smtp.gmail.com)");
      required("SMTP_USER", "required when EMAIL_DRIVER=smtp (Gmail: your full address)");
      required(
        "SMTP_PASSWORD",
        "required when EMAIL_DRIVER=smtp (Gmail: a 16-character App Password, not your account password)",
      );

      // Port and TLS mode must agree, or the connection hangs instead of failing
      // cleanly — a miserable thing to debug.
      if (env.SMTP_PORT === 465 && !env.SMTP_SECURE) {
        ctx.addIssue({
          code: "custom",
          path: ["SMTP_SECURE"],
          message: "must be true on port 465 (implicit TLS)",
        });
      }
      if (env.SMTP_PORT === 587 && env.SMTP_SECURE) {
        ctx.addIssue({
          code: "custom",
          path: ["SMTP_SECURE"],
          message: "must be false on port 587 (STARTTLS)",
        });
      }
    }

    if (env.EMAIL_DRIVER === "resend") {
      required("RESEND_API_KEY", "required when EMAIL_DRIVER=resend");
    }

    if (env.EMAIL_DRIVER === "ses") {
      required("AWS_REGION", "required when EMAIL_DRIVER=ses (e.g. us-east-1)");
      // One key without the other silently falls back to the ambient credential
      // chain and then fails confusingly.
      const hasId = Boolean(env.AWS_ACCESS_KEY_ID);
      const hasSecret = Boolean(env.AWS_SECRET_ACCESS_KEY);
      if (hasId !== hasSecret) {
        ctx.addIssue({
          code: "custom",
          path: [hasId ? "AWS_SECRET_ACCESS_KEY" : "AWS_ACCESS_KEY_ID"],
          message: "set both AWS keys, or neither to use the ambient IAM role",
        });
      }
    }

    /**
     * Stripe is all-or-nothing. A half-configured integration is the worst of the
     * three states: the booking flow offers a pay button, the Checkout Session is
     * created, the parent is charged — and with no signing secret the webhook that
     * is the *only* source of payment truth can never be verified, so the booking
     * sits unpaid forever while the money is real.
     */
    const stripeKeys = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PUBLISHABLE_KEY",
      "STRIPE_PROJECT_KEY",
    ] as const;

    if (stripeKeys.some((key) => env[key])) {
      for (const key of stripeKeys) {
        required(
          key,
          "required once any STRIPE_* variable is set — a partially configured payment path can charge a card it cannot then confirm",
        );
      }

      /*
       * Mode agreement. Mixing a live secret with a test publishable key produces
       * a Checkout Session the browser cannot mount, and the reverse silently
       * takes real money in what someone believes is a test.
       */
      const secretMode = env.STRIPE_SECRET_KEY?.includes("_live_") ? "live" : "test";
      const publishableMode = env.STRIPE_PUBLISHABLE_KEY?.includes("_live_")
        ? "live"
        : "test";

      if (env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY && secretMode !== publishableMode) {
        ctx.addIssue({
          code: "custom",
          path: ["STRIPE_PUBLISHABLE_KEY"],
          message: `is a ${publishableMode} key but STRIPE_SECRET_KEY is ${secretMode} — both must be the same mode`,
        });
      }
    }

    /**
     * A real deployment, whatever NODE_ENV happens to say.
     *
     * The guards below are the ones that keep a driver that sends no mail out of
     * production, keep live tokens off disk, and keep a test Stripe key out of a
     * live checkout. Keying them on NODE_ENV alone made all of them switchable by
     * one mis-set variable — which is exactly what happened on the first Vercel
     * deployment, where NODE_ENV was not "production" and every one of these
     * silently stopped applying.
     */
    const isProductionLike =
      env.NODE_ENV === "production" || env.VERCEL_ENV === "production";

    if (isProductionLike && env.STRIPE_SECRET_KEY?.includes("_test_")) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "is a test key — production would take no real payments",
      });
    }

    if (isProductionLike) {
      if (env.EMAIL_DRIVER === "console") {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_DRIVER"],
          message: "the console driver sends no mail — use smtp, resend, or ses in production",
        });
      }
      if (env.EMAIL_OUTBOX_FILE) {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_OUTBOX_FILE"],
          message:
            "must not be set in production — it writes live verification and reset tokens to disk",
        });
      }
    }
  });

export type ParsedEnv = z.infer<typeof envSchema>;
