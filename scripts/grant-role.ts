/**
 * Grants or revokes a role on an existing account.
 *
 * Staff are invite-only with no public route and there's no role-grant endpoint
 * until Phase 2, so this is the supported way to promote someone in the meantime.
 * Every change is written to the audit log, same as the eventual admin UI will.
 *
 *   npm run grant-role -- someone@example.com coordinator
 *   npm run grant-role -- someone@example.com coordinator --revoke
 */
import { and, eq, isNull, sql as rawSql } from "drizzle-orm";

import { USER_ROLES, type UserRole } from "../src/contracts/roles.ts";
import { closeDatabase, db } from "../src/db/client.ts";
import { userRoles, users } from "../src/db/schema/index.ts";
import { logger } from "../src/lib/logger.ts";
import { recordAudit } from "../src/services/audit.service.ts";

const [rawEmail, rawRole, ...flags] = process.argv.slice(2);
const revoke = flags.includes("--revoke");

function usage(message: string): never {
  console.error(
    `${message}\n\n` +
      "usage: npm run grant-role -- <email> <role> [--revoke]\n" +
      `roles: ${USER_ROLES.join(" | ")}`,
  );
  process.exit(2);
}

if (!rawEmail || !rawRole) usage("Missing email or role.");
if (!(USER_ROLES as readonly string[]).includes(rawRole)) usage(`Unknown role "${rawRole}".`);

const email = rawEmail.trim().toLowerCase();
const role = rawRole as UserRole;

async function main() {
  const [user] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(and(rawSql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
    .limit(1);

  if (!user) usage(`No account found for ${email}.`);

  /*
   * Nothing else can grant the admin role — `seed:admin` only bootstraps, and there
   * is no role-grant endpoint yet — so revoking the last one leaves the platform
   * with no way to invite staff, approve educators, or grant the role back. Only
   * live accounts count: a soft-deleted admin cannot sign in to undo this.
   */
  if (revoke && role === "admin") {
    const admins = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(userRoles.role, "admin"), isNull(users.deletedAt)));

    if (admins.length <= 1) {
      usage(
        `Refusing to revoke the last remaining admin role (${email}). ` +
          "Grant admin to another account first.",
      );
    }
  }

  if (revoke) {
    const removed = await db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, user.id), eq(userRoles.role, role)))
      .returning({ id: userRoles.id });

    if (removed.length === 0) {
      logger.info({ email, role }, "role was not held — nothing to revoke");
      return;
    }

    await recordAudit(db, {
      // Null, not the subject. Passing `user.id` recorded that the demoted user
      // demoted themselves, which inverts the one fact the row exists to carry.
      // `audit_log.actor_id` is nullable for CLI and timer actions; the operator
      // marker below identifies the path, and no fake uuid is invented.
      actorId: null,
      action: "user.role_revoked",
      entityType: "user_roles",
      entityId: user.id,
      before: { role, subject: email },
      after: { operator: "cli:grant-role" },
    });
    logger.warn(
      { email, role },
      "role revoked — any session already acting as that role stops working",
    );
    return;
  }

  const granted = await db
    .insert(userRoles)
    .values({ userId: user.id, role })
    .onConflictDoNothing()
    .returning({ id: userRoles.id });

  if (granted.length === 0) {
    logger.info({ email, role }, "role already held — no change");
    return;
  }

  await recordAudit(db, {
    // See the revoke branch: the actor is an operator at a terminal, not the
    // account being promoted.
    actorId: null,
    action: "user.role_granted",
    entityType: "user_roles",
    entityId: user.id,
    after: { role, subject: email, operator: "cli:grant-role" },
  });

  logger.info({ email, role }, "role granted");

  // Active role is resolved at login by highest privilege and pinned for the
  // session's life, so an existing session won't pick this up.
  logger.info("the user must sign out and back in for this to take effect");
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, "grant-role failed");
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
