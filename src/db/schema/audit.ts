import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { uuidv7 } from "../../lib/id.ts";
import { users } from "./auth.ts";
import { userRoleEnum } from "./enums.ts";

/**
 * Append-only audit trail. In production the application's database role must
 * be granted INSERT and SELECT only on this table — the code not issuing
 * UPDATE/DELETE is not the same guarantee as the code not being *able* to.
 * That grant is applied by hand after the first migration; see server/README.md.
 *
 * Phase 1 writes: role grants, invites issued and accepted, educator
 * application review and approval, password resets, and staff logins.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().$defaultFn(uuidv7),
    /** Null for unauthenticated actions (a failed login, a public application). */
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    actorRole: userRoleEnum(),
    /** Dotted verb, e.g. "educator_application.approved", "user.role_granted". */
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    before: jsonb(),
    after: jsonb(),
    ip: text(),
    /** Fastify's request id, to correlate a log line with its audit row. */
    requestId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    index("audit_log_actor_idx").on(table.actorId),
    index("audit_log_action_idx").on(table.action),
  ],
);
