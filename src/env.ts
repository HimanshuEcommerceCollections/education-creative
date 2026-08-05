import { z } from "zod";

/**
 * Loads `.env` using Node's built-in loader (no dotenv dependency). Real
 * deployments inject env vars directly, so a missing file is not an error.
 */
function loadEnvFile() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env present — env vars come from the platform / secrets broker.
  }
}

/** 32 raw bytes, base64-encoded, as produced by `randomBytes(32).toString("base64")`. */
const base64Key32 = z
  .string()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "must be exactly 32 bytes, base64-encoded",
  });

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: z.string().startsWith("postgres"),
    WEB_ORIGIN: z.url(),

    SESSION_PEPPER: z.string().min(32),
    FIELD_ENCRYPTION_KEY: base64Key32,

    MFA_REQUIRED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),

    EMAIL_DRIVER: z.enum(["console", "resend", "smtp"]).default("console"),
    EMAIL_FROM: z.string().min(3),
    RESEND_API_KEY: z.string().optional(),
    SMTP_URL: z.string().optional(),

    SEED_ADMIN_EMAIL: z.email().optional(),
    SEED_ADMIN_PASSWORD: z.string().optional(),
    SEED_ADMIN_NAME: z.string().optional(),
  })
  // Fail-closed on the combinations that would otherwise blow up at the moment
  // an email is first sent, or silently leave staff unprotected in production.
  .superRefine((env, ctx) => {
    if (env.EMAIL_DRIVER === "resend" && !env.RESEND_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "required when EMAIL_DRIVER=resend",
      });
    }
    if (env.EMAIL_DRIVER === "smtp" && !env.SMTP_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_URL"],
        message: "required when EMAIL_DRIVER=smtp",
      });
    }
    if (env.NODE_ENV === "production") {
      if (!env.MFA_REQUIRED) {
        ctx.addIssue({
          code: "custom",
          path: ["MFA_REQUIRED"],
          message: "must be true in production — staff TOTP is mandatory",
        });
      }
      if (env.EMAIL_DRIVER === "console") {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_DRIVER"],
          message: "the console driver sends no mail — use resend or smtp in production",
        });
      }
    }
  });

function parseEnv() {
  loadEnvFile();
  const result = schema.safeParse(process.env);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    // Deliberately not the logger: config is invalid, so nothing is booted yet.
    console.error(`Invalid environment configuration:\n${lines.join("\n")}`);
    process.exit(1);
  }

  return result.data;
}

export const env = parseEnv();

export type Env = typeof env;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
