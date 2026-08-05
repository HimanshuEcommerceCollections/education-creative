import { envSchema } from "./env-schema.ts";

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
