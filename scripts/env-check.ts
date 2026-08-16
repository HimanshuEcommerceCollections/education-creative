/**
 * Exercises the per-driver email validation in `src/env.ts` against synthetic
 * configs, so the rules that only fire on a misconfiguration are actually
 * proven rather than assumed.
 *
 *   npx tsx scripts/env-check.ts
 */
import { envSchema } from "../src/env-schema.ts";

/**
 * Synthetic values only. Both secrets are derived at runtime rather than written
 * as literals, so no real key can end up committed here by copy-paste — which is
 * exactly how this file first got written.
 */
const BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@host/db",
  WEB_ORIGIN: "http://localhost:3000",
  SESSION_PEPPER: "a".repeat(43),
  // 32 zero bytes — valid shape, obviously not a key.
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  EMAIL_FROM: "Your Learning Journey <no-reply@example.com>",
};

let failures = 0;

function check(label: string, overrides: Record<string, string>, expect: "ok" | string) {
  const result = envSchema.safeParse({ ...BASE, ...overrides });
  const paths = result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));

  const passed = expect === "ok" ? result.success : paths.includes(expect);
  if (!passed) failures += 1;

  const detail = result.success
    ? "accepted"
    : `rejected on ${paths.join(", ") || "(root)"}`;
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}\n        ${detail}`);
}

console.log("\n— smtp / Gmail —");
check("host, user and password are all required", { EMAIL_DRIVER: "smtp" }, "SMTP_HOST");
check(
  "port 465 must use implicit TLS",
  {
    EMAIL_DRIVER: "smtp",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "false",
    SMTP_USER: "a@b.com",
    SMTP_PASSWORD: "x",
  },
  "SMTP_SECURE",
);
check(
  "port 587 must use STARTTLS",
  {
    EMAIL_DRIVER: "smtp",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "true",
    SMTP_USER: "a@b.com",
    SMTP_PASSWORD: "x",
  },
  "SMTP_SECURE",
);
check(
  "a valid Gmail config is accepted",
  {
    EMAIL_DRIVER: "smtp",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "a@b.com",
    SMTP_PASSWORD: "abcdefghijklmnop",
  },
  "ok",
);

// Google shows app passwords in groups of four; pasting them verbatim is the
// single most common setup mistake.
const spaced = envSchema.safeParse({
  ...BASE,
  EMAIL_DRIVER: "smtp",
  SMTP_HOST: "smtp.gmail.com",
  SMTP_USER: "a@b.com",
  SMTP_PASSWORD: "abcd efgh ijkl mnop",
});
const strippedOk =
  spaced.success && spaced.data.SMTP_PASSWORD === "abcdefghijklmnop";
if (!strippedOk) failures += 1;
console.log(
  `${strippedOk ? "PASS" : "FAIL"}  spaces are stripped from a pasted app password\n` +
    `        ${spaced.success ? JSON.stringify(spaced.data.SMTP_PASSWORD) : "rejected"}`,
);

console.log("\n— resend —");
check("api key is required", { EMAIL_DRIVER: "resend" }, "RESEND_API_KEY");
check("valid config accepted", { EMAIL_DRIVER: "resend", RESEND_API_KEY: "re_x" }, "ok");

console.log("\n— ses —");
check("region is required", { EMAIL_DRIVER: "ses" }, "AWS_REGION");
check(
  "one AWS key without the other is rejected",
  { EMAIL_DRIVER: "ses", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIA" },
  "AWS_SECRET_ACCESS_KEY",
);
check(
  "no AWS keys is fine (ambient IAM role)",
  { EMAIL_DRIVER: "ses", AWS_REGION: "us-east-1" },
  "ok",
);
check(
  "both AWS keys accepted",
  {
    EMAIL_DRIVER: "ses",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "AKIA",
    AWS_SECRET_ACCESS_KEY: "secret",
  },
  "ok",
);

console.log("\n— production guards —");
check(
  "console driver rejected in production",
  { NODE_ENV: "production", EMAIL_DRIVER: "console" },
  "EMAIL_DRIVER",
);
/** Everything production demands, so the "accepted" case stays meaningful. */
const PRODUCTION = {
  NODE_ENV: "production",
  EMAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_x",
};

check("a valid production config is accepted", PRODUCTION, "ok");
check("console driver is fine in development", { EMAIL_DRIVER: "console" }, "ok");
check(
  "an outbox file is refused in production (it writes live tokens to disk)",
  { ...PRODUCTION, EMAIL_OUTBOX_FILE: "/tmp/outbox.jsonl" },
  "EMAIL_OUTBOX_FILE",
);

console.log("\n— stripe test-mode guard —");
/** A complete, mode-consistent test-key Stripe config. */
const STRIPE_TEST = {
  STRIPE_SECRET_KEY: "rk_test_x",
  STRIPE_PUBLISHABLE_KEY: "pk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PROJECT_KEY: "ylj",
};

check(
  "a test key is refused in production by default",
  { ...PRODUCTION, ...STRIPE_TEST },
  "STRIPE_SECRET_KEY",
);
check(
  "a test key is accepted in production with the explicit opt-in",
  { ...PRODUCTION, ...STRIPE_TEST, STRIPE_ALLOW_TEST_MODE: "true" },
  "ok",
);
check(
  "the opt-in must be removed once the keys are live",
  {
    ...PRODUCTION,
    ...STRIPE_TEST,
    STRIPE_SECRET_KEY: "rk_live_x",
    STRIPE_PUBLISHABLE_KEY: "pk_live_x",
    STRIPE_ALLOW_TEST_MODE: "true",
  },
  "STRIPE_ALLOW_TEST_MODE",
);
check(
  "a live production config is accepted without the flag",
  {
    ...PRODUCTION,
    ...STRIPE_TEST,
    STRIPE_SECRET_KEY: "rk_live_x",
    STRIPE_PUBLISHABLE_KEY: "pk_live_x",
  },
  "ok",
);

console.log("\n— a variable that claims a control we don't have —");
/*
 * MFA_REQUIRED=true was set on a production deployment and read by nothing. The
 * object isn't strict, so it parsed clean; an operator reading the dashboard would
 * reasonably conclude staff MFA was enforced. Staff auth is password-only by
 * design, so the variable is refused rather than ignored.
 */
check("MFA_REQUIRED is rejected outright", { MFA_REQUIRED: "true" }, "MFA_REQUIRED");
check("even set to false, because its presence is the problem", { MFA_REQUIRED: "false" }, "MFA_REQUIRED");
check("and blank, so a leftover empty variable is still caught", { MFA_REQUIRED: "" }, "MFA_REQUIRED");

console.log("\n— the BFF→API hop —");
check("no internal secret is allowed (existing deployments keep booting)", {}, "ok");
check(
  "a real one is accepted",
  { INTERNAL_API_SECRET: "s".repeat(43) },
  "ok",
);
check(
  "a short one is refused — it's a shared secret, not a password",
  { INTERNAL_API_SECRET: "too-short" },
  "INTERNAL_API_SECRET",
);
check("a cron secret is optional", { CRON_SECRET: "c".repeat(32) }, "ok");

console.log("\n— guards can't be bypassed by a mis-set NODE_ENV —");
/*
 * This is what the first Vercel deployment actually did: NODE_ENV was not
 * "production" on a production deployment, so the mail driver and the outbox
 * both silently stopped being checked.
 */
check(
  "a production Vercel deployment still refuses the console driver",
  { NODE_ENV: "development", VERCEL_ENV: "production", EMAIL_DRIVER: "console" },
  "EMAIL_DRIVER",
);
check(
  "a production Vercel deployment still refuses an outbox file",
  {
    NODE_ENV: "development",
    VERCEL_ENV: "production",
    EMAIL_DRIVER: "resend",
    RESEND_API_KEY: "re_x",
    EMAIL_OUTBOX_FILE: "/tmp/outbox.jsonl",
  },
  "EMAIL_OUTBOX_FILE",
);
check(
  "a Vercel preview deployment is not held to production rules",
  { NODE_ENV: "development", VERCEL_ENV: "preview", EMAIL_DRIVER: "console" },
  "ok",
);

console.log(
  failures === 0 ? "\nAll env validation checks passed.\n" : `\n${failures} failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
