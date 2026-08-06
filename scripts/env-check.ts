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
  { NODE_ENV: "production", EMAIL_DRIVER: "console", MFA_REQUIRED: "true" },
  "EMAIL_DRIVER",
);
check(
  "MFA cannot be disabled in production",
  {
    NODE_ENV: "production",
    EMAIL_DRIVER: "resend",
    RESEND_API_KEY: "re_x",
    MFA_REQUIRED: "false",
  },
  "MFA_REQUIRED",
);
/** Everything production demands, so the "accepted" case stays meaningful. */
const PRODUCTION = {
  NODE_ENV: "production",
  EMAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_x",
  MFA_REQUIRED: "true",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
};

check("a valid production config is accepted", PRODUCTION, "ok");
check("console driver is fine in development", { EMAIL_DRIVER: "console" }, "ok");
check(
  "an outbox file is refused in production (it writes live tokens to disk)",
  { ...PRODUCTION, EMAIL_OUTBOX_FILE: "/tmp/outbox.jsonl" },
  "EMAIL_OUTBOX_FILE",
);

console.log("\n— rate limiting —");
check(
  "production requires a distributed limiter",
  { ...PRODUCTION, UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" },
  "UPSTASH_REDIS_REST_URL",
);
check(
  "an Upstash url without its token is rejected",
  { UPSTASH_REDIS_REST_URL: "https://example.upstash.io" },
  "UPSTASH_REDIS_REST_TOKEN",
);
check(
  "an Upstash token without its url is rejected",
  { UPSTASH_REDIS_REST_TOKEN: "token" },
  "UPSTASH_REDIS_REST_URL",
);
check(
  "neither is fine in development (in-process limiter)",
  { EMAIL_DRIVER: "console" },
  "ok",
);

console.log(
  failures === 0 ? "\nAll env validation checks passed.\n" : `\n${failures} failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
