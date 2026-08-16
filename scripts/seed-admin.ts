import { and, eq, isNull, sql as rawSql } from "drizzle-orm";

import { PASSWORD_MIN_LENGTH } from "../src/contracts/auth.ts";
import { closeDatabase, db } from "../src/db/client.ts";
import { authIdentities, userRoles, users } from "../src/db/schema/index.ts";
import { env } from "../src/env.ts";
import { logger } from "../src/lib/logger.ts";
import { hashPassword } from "../src/lib/password.ts";
import { recordAudit } from "../src/services/audit.service.ts";

/**
 * Bootstraps the first admin. Staff are invite-only with no public route, which
 * leaves a chicken-and-egg problem: someone has to exist before anyone can be
 * invited. That someone is created here, deliberately out-of-band and
 * server-side only.
 *
 * Idempotent — re-running grants the admin role to an existing account rather
 * than failing, so it's safe in a deploy script.
 */
async function main(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL;
  const password = env.SEED_ADMIN_PASSWORD;
  const fullName = env.SEED_ADMIN_NAME ?? "Platform Admin";

  if (!email || !password) {
    throw new Error(
      "Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in server/.env before seeding.",
    );
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(
      `SEED_ADMIN_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    );
  }

  const normalisedEmail = email.trim().toLowerCase();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(rawSql`lower(${users.email}) = ${normalisedEmail}`, isNull(users.deletedAt)))
    .limit(1);

  if (existing) {
    const granted = await db
      .insert(userRoles)
      .values({ userId: existing.id, role: "admin" })
      .onConflictDoNothing()
      .returning({ id: userRoles.id });

    if (granted.length === 0) {
      logger.info({ email: normalisedEmail }, "account already holds the admin role");
      return;
    }

    /*
     * This branch is a privilege escalation on an account that already existed —
     * possibly one that self-signed-up as a customer — so it has to leave a trace, or
     * a routine deploy seed quietly mints an admin. Audited with a null actor and an
     * operator marker, same as the CLI role scripts.
     */
    await recordAudit(db, {
      actorId: null,
      action: "user.role_granted",
      entityType: "user_roles",
      entityId: existing.id,
      after: {
        role: "admin",
        subject: normalisedEmail,
        operator: "cli:seed-admin",
        escalatedExistingAccount: true,
      },
    });

    logger.warn(
      { email: normalisedEmail },
      "an existing account was escalated to admin — verify this address is meant to be one",
    );
    return;
  }

  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: normalisedEmail,
        passwordHash,
        fullName,
        status: "active",
        // Seeded out-of-band by an operator who is, definitionally, an adult.
        ageGateAttestedAt: new Date(),
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });

    const userId = user!.id;

    await tx.insert(userRoles).values({ userId, role: "admin" });
    await tx.insert(authIdentities).values({
      userId,
      provider: "password",
      providerAccountId: userId,
    });

    await recordAudit(tx, {
      // An operator at a terminal, not the account being created — it did not
      // exist a statement ago and cannot have been the actor.
      actorId: null,
      action: "user.seeded_first_admin",
      entityType: "users",
      entityId: userId,
      after: { email: normalisedEmail, operator: "cli:seed-admin" },
    });
  });

  logger.info({ email: normalisedEmail }, "admin created");
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, "seeding failed");
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
