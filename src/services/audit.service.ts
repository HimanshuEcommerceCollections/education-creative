import type { UserRole } from "../contracts/roles.ts";
import { db, type DbOrTx } from "../db/client.ts";
import { auditLog } from "../db/schema/index.ts";
import { logger } from "../lib/logger.ts";

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: UserRole | null;
  /** Dotted verb, e.g. "user.signed_up", "educator_application.approved". */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

/**
 * Appends an audit row. Pass a transaction handle when the audited change and
 * its record must land together — an approval that creates an account but loses
 * its audit row is worse than one that fails outright.
 */
export async function recordAudit(tx: DbOrTx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: entry.actorId ?? null,
    actorRole: entry.actorRole ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
    requestId: entry.requestId ?? null,
  });
}

/**
 * Fire-and-forget variant for observations that must not fail the request they
 * describe. Logs loudly on failure so a broken audit path is visible rather than
 * silent.
 *
 * **Best-effort, not guaranteed.** On a serverless invocation the instance can
 * freeze the moment the response completes, so a detached insert lands or doesn't
 * depending on timing. Anything the schema or the docs describe as always recorded
 * — logins, refusals, privileged actions — must therefore use `recordAudit` and
 * await it; the auth paths do. Use this only where a missing row is genuinely
 * acceptable.
 */
export function recordAuditDetached(entry: AuditEntry): void {
  void recordAudit(db, entry).catch((error) => {
    logger.error({ err: error, action: entry.action }, "failed to write audit row");
  });
}
