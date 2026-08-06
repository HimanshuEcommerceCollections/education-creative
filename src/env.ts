import { envSchema } from "./env-schema.ts";

/**
 * Loads `.env` using Node's built-in loader (no dotenv dependency), then restores
 * anything that was **already** in the environment.
 *
 * That restore matters: `process.loadEnvFile()` overwrites existing values, which
 * inverts the precedence every deployment platform assumes. A real environment
 * variable has to beat a checked-out `.env` — otherwise a stray file in the
 * working directory silently overrides what the host injected, and a one-off
 * `EMAIL_DRIVER=console npm run …` does nothing at all.
 *
 * A missing file is not an error: real deployments inject variables directly.
 */
function loadEnvFile() {
  const injected = { ...process.env };

  try {
    process.loadEnvFile();
  } catch {
    return; // No .env — the platform or secrets broker supplies everything.
  }

  for (const [key, value] of Object.entries(injected)) {
    if (value !== undefined) process.env[key] = value;
  }
}

/**
 * Parses and validates the environment, exiting on anything invalid.
 *
 * Importing this module therefore has a side effect. The schema itself lives in
 * `env-schema.ts` so it can be tested without that.
 */
function parseEnv() {
  loadEnvFile();
  const result = envSchema.safeParse(process.env);

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
