import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env, isProduction } from "../env.ts";
import * as schema from "./schema/index.ts";

/**
 * Neon's pooled endpoint routes through PgBouncer in transaction mode, which
 * cannot hold server-side prepared statements across a pool checkout. Detect it
 * from the host and disable prepares rather than making it a separate env var
 * someone has to remember to flip.
 */
const isPooledConnection = env.DATABASE_URL.includes("-pooler.");

export const sql = postgres(env.DATABASE_URL, {
  max: isProduction ? 10 : 4,
  idle_timeout: 30,
  connect_timeout: 15,
  prepare: !isPooledConnection,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema, casing: "snake_case" });

export type Database = typeof db;

/** Transaction handle — what service functions receive so they compose. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either the pool or an open transaction. Services accept this. */
export type DbOrTx = Database | Tx;

export async function closeDatabase() {
  await sql.end({ timeout: 5 });
}
