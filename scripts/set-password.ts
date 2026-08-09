/**
 * Sets an account's password out-of-band.
 *
 * The supported path is the emailed reset link; this exists for the cases that
 * link can't reach — a locked-out admin, a mailbox that isn't wired up yet, or a
 * local dev account. It does what `resetPassword` does minus the token: rehash,
 * clear the lockout counters, and drop every session, because a credential
 * change that leaves old sessions alive isn't a credential change.
 *
 *   npm run set-password -- someone@example.com 'new-password'
 *   npm run set-password -- someone@example.com 'short' --allow-weak
 */
import { and, eq, isNull, sql as rawSql } from "drizzle-orm";

import { PASSWORD_MIN_LENGTH } from "../src/contracts/auth.ts";
import { closeDatabase, db } from "../src/db/client.ts";
import { authIdentities, users } from "../src/db/schema/index.ts";
import { logger } from "../src/lib/logger.ts";
import { hashPassword } from "../src/lib/password.ts";
import { recordAudit } from "../src/services/audit.service.ts";
import { revokeAllSessionsForUser } from "../src/services/session.service.ts";

const [rawEmail, newPassword, ...flags] = process.argv.slice(2);
const allowWeak = flags.includes("--allow-weak");

function usage(message: string): never {
  console.error(
    `${message}\n\n` +
      "usage: npm run set-password -- <email> <password> [--allow-weak]\n" +
      `passwords shorter than ${PASSWORD_MIN_LENGTH} characters need --allow-weak`,
  );
  process.exit(2);
}

if (!rawEmail || !newPassword) usage("Missing email or password.");
if (newPassword.length < PASSWORD_MIN_LENGTH && !allowWeak) {
  usage(`Password is under the ${PASSWORD_MIN_LENGTH}-character minimum.`);
}

const email = rawEmail.trim().toLowerCase();

async function main() {
  const [user] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(and(rawSql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
    .limit(1);

  if (!user) usage(`No account found for ${email}.`);

  const passwordHash = await hashPassword(newPassword!);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, user.id));

    // An invited or OAuth-only account had no password identity until now.
    await tx
      .insert(authIdentities)
      .values({ userId: user.id, provider: "password", providerAccountId: user.id })
      .onConflictDoNothing();

    await revokeAllSessionsForUser(tx, user.id);

    await recordAudit(tx, {
      actorId: user.id,
      action: "auth.password_set_by_operator",
      entityType: "users",
      entityId: user.id,
    });
  });

  logger.info({ email, status: user.status }, "password set — all sessions revoked");

  if (newPassword!.length < PASSWORD_MIN_LENGTH) {
    logger.warn(
      { minimum: PASSWORD_MIN_LENGTH },
      "this password is below the signup minimum; login accepts it, but a reset never would",
    );
  }
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, "set-password failed");
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
