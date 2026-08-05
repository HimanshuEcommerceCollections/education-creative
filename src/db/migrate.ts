import { migrate } from "drizzle-orm/postgres-js/migrator";

import { closeDatabase, db } from "./client.ts";
import { logger } from "../lib/logger.ts";

/**
 * Applies pending migrations. Run against a hosted branch, so it is deliberately
 * a separate command rather than something the server does on boot — an
 * unattended migration during a rolling deploy is how you get two schema
 * versions live at once.
 */
try {
  logger.info("applying migrations");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("migrations applied");
} catch (error) {
  logger.fatal({ err: error }, "migration failed");
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
