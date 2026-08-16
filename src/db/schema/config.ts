import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth.ts";

/**
 * Site configuration (ARCHITECTURE.md §7) — the namespaced, Zod-validated KV
 * store behind the admin dashboard. Postgres is the source of truth and the
 * dashboard is the only editor; no third-party CMS.
 *
 * **Sparse on purpose.** A row exists only where an admin has overridden the
 * shipped default, so an empty table means "behave exactly as the code did", and
 * `config-registry.ts` is the one place a default is written down. That is also
 * what makes "reset to default" a `DELETE` rather than a second copy of the
 * launch numbers.
 *
 * **Not effective-dated**, unlike the pricing tables next door, and deliberately:
 * a quote freezes the take rate it was priced at (`quotes.take_rate_bps`, carried
 * onto the booking as `take_rate_bps_snapshot`), so replaying an old charge reads
 * the frozen figure and never this table. History lives in `audit_log`, which
 * every write here appends to before it commits.
 *
 * **No secrets.** Stripe keys, the internal API secret and the mail credentials
 * are environment variables validated by `env-schema.ts`. A settings row is
 * readable by anyone with a Postgres connection and editable from a browser;
 * neither is true of a secret worth having.
 */
export const configSettings = pgTable("config_settings", {
  /** Namespaced key from `CONFIG_KEYS` — "booking.min_notice_hours". */
  key: text().primaryKey(),
  /**
   * The scalar, as JSON. `jsonb` rather than text so a boolean stays a boolean
   * through the round trip and nothing has to parse `"false"` — which is truthy
   * in every language that would read it.
   */
  value: jsonb().notNull(),
  updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
