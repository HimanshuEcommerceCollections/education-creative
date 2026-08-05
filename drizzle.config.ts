import { defineConfig } from "drizzle-kit";

/**
 * `db:generate` only reads the schema, so it works offline without a real
 * `DATABASE_URL`. `db:migrate` and `db:studio` need a live connection.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder",
  },
  casing: "snake_case",
  strict: true,
  verbose: true,
});
