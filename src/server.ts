import { buildApp } from "./app.ts";
import { closeDatabase } from "./db/client.ts";
import { env } from "./env.ts";
import { logger } from "./lib/logger.ts";

const app = await buildApp();

/**
 * Drain in-flight requests before closing the pool, so a deploy doesn't abort a
 * transaction mid-signup.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  try {
    await app.close();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled rejection — exiting");
  process.exit(1);
});

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
}
