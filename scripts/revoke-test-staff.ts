/**
 * Strips privilege from accounts created by tests and seeds.
 *
 * Test runs leave behind real, working accounts — `multirole.*` ones hold
 * `coordinator`, and the seeds create educators — and their passwords are not
 * secrets: they are literals in `scripts/e2e.ts`, `scripts/seed-bookings.ts` and
 * `scripts/seed-reviews.ts`, which are committed. Anyone holding the repository
 * can therefore sign in to whatever database those scripts were last pointed at.
 *
 * That matters beyond tidiness because a coordinator can read
 * `GET /bookings/:id/child-details`, which decrypts a learner's first name and
 * their home address. While every learner is fictional nothing real is exposed,
 * but the capability is live the moment one isn't.
 *
 * So this removes the privilege rather than the data: role grants go, sessions
 * are killed, and the account is deactivated. The bookings, learners, reviews and
 * ledger rows are left exactly as they are — they are the demo content the
 * dashboards render, and they are not what makes this a problem.
 *
 * Idempotent, and scoped to `@example.com` only. Real accounts and the
 * `SEED_ADMIN_EMAIL` bootstrap admin (whose password is an environment secret,
 * not a committed literal) are never touched.
 *
 *   npx tsx scripts/revoke-test-staff.ts          # what it would change
 *   npx tsx scripts/revoke-test-staff.ts --apply  # change it
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { closeDatabase, db } from "../src/db/client.ts";
import { sessions, userRoles, users } from "../src/db/schema/index.ts";
import { logger } from "../src/lib/logger.ts";
import { recordAudit } from "../src/services/audit.service.ts";

/** The roles worth taking away. `customer` is left alone: a seeded parent can
 * only ever see their own fictional bookings, and those logins are what make the
 * account pages demonstrable. */
const PRIVILEGED = ["admin", "coordinator", "educator"] as const;

const apply = process.argv.includes("--apply");

const targets = await db
  .selectDistinct({ id: users.id, email: users.email, status: users.status })
  .from(users)
  .innerJoin(userRoles, eq(userRoles.userId, users.id))
  .where(and(like(users.email, "%@example.com"), inArray(userRoles.role, [...PRIVILEGED])))
  .orderBy(users.email);

if (targets.length === 0) {
  console.log("Nothing to do: no @example.com account holds a privileged role.");
  await closeDatabase();
  process.exit(0);
}

console.log(`${targets.length} test account(s) hold a privileged role:\n`);
for (const target of targets) {
  const roles = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, target.id));
  console.log(
    `  ${target.email.padEnd(46)} [${roles.map((r) => r.role).join(",")}] ${target.status}`,
  );
}

if (!apply) {
  console.log(
    "\nDry run. Nothing changed. Re-run with --apply to revoke these roles, kill" +
      "\ntheir sessions and deactivate the accounts. No booking, learner, review or" +
      "\nledger row is touched either way.",
  );
  await closeDatabase();
  process.exit(0);
}

const ids = targets.map((target) => target.id);

const result = await db.transaction(async (tx) => {
  const removedRoles = await tx
    .delete(userRoles)
    .where(and(inArray(userRoles.userId, ids), inArray(userRoles.role, [...PRIVILEGED])))
    .returning({ userId: userRoles.userId });

  // Killed rather than left to expire: a session was minted with its role pinned
  // on it, so revoking the grant alone leaves the privilege usable until it lapses.
  const killedSessions = await tx
    .delete(sessions)
    .where(inArray(sessions.userId, ids))
    .returning({ id: sessions.id });

  await tx
    .update(users)
    .set({ status: "deactivated" })
    .where(inArray(users.id, ids));

  for (const target of targets) {
    await recordAudit(tx, {
      actorId: null,
      action: "user.test_privilege_revoked",
      entityType: "users",
      entityId: target.id,
      before: { email: target.email, status: target.status },
      after: {
        status: "deactivated",
        operator: "cli:revoke-test-staff",
        reason: "test account with a committed password held a privileged role",
      },
    });
  }

  return { roles: removedRoles.length, sessions: killedSessions.length };
});

logger.info(
  { accounts: targets.length, roles: result.roles, sessions: result.sessions },
  "revoked privilege from test accounts",
);

const [remaining] = await db
  .select({ count: sql<number>`count(*)` })
  .from(users)
  .innerJoin(userRoles, eq(userRoles.userId, users.id))
  .where(and(like(users.email, "%@example.com"), inArray(userRoles.role, [...PRIVILEGED])));

console.log(
  `\nRevoked ${result.roles} role grant(s) across ${targets.length} account(s), ` +
    `killed ${result.sessions} session(s).\n` +
    `Privileged @example.com accounts remaining: ${remaining?.count ?? "?"}`,
);

await closeDatabase();
