import { and, eq, isNull } from "drizzle-orm";

import { TOKEN_TTL } from "../constants.ts";
import { db, type DbOrTx } from "../db/client.ts";
import { emailTokens } from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { generateToken, hashToken } from "../lib/tokens.ts";

type Purpose = "email_verification" | "password_reset" | "invite";

const TTL_MS: Record<Purpose, number> = {
  email_verification: TOKEN_TTL.emailVerificationHours * 60 * 60_000,
  password_reset: TOKEN_TTL.passwordResetMinutes * 60_000,
  invite: TOKEN_TTL.inviteDays * 24 * 60 * 60_000,
};

/**
 * Issues a single-use token and returns the plaintext — the only copy that will
 * ever exist outside the recipient's inbox.
 *
 * Any outstanding token of the same purpose is consumed first, so requesting a
 * second reset link silently invalidates the first. Without this, every reset
 * request would widen the window of live tokens for that account.
 */
export async function issueEmailToken(
  tx: DbOrTx,
  userId: string,
  purpose: Purpose,
): Promise<{ token: string; expiresAt: Date }> {
  await tx
    .update(emailTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailTokens.userId, userId),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.consumedAt),
      ),
    );

  const token = generateToken();
  const expiresAt = new Date(Date.now() + TTL_MS[purpose]);

  await tx.insert(emailTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return { token, expiresAt };
}

export interface ResolvedToken {
  id: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Looks a token up without consuming it — for the invite page, which needs to
 * render the invitee's name before they submit a password.
 *
 * Distinguishes expired from invalid, because for these flows that's genuinely
 * useful ("your link expired, here's a new one") and reveals nothing: the token
 * itself is the secret, so anyone holding a real one already had the link.
 */
export async function peekEmailToken(
  token: string,
  purpose: Purpose,
): Promise<ResolvedToken> {
  const [row] = await db
    .select({
      id: emailTokens.id,
      userId: emailTokens.userId,
      expiresAt: emailTokens.expiresAt,
      consumedAt: emailTokens.consumedAt,
    })
    .from(emailTokens)
    .where(
      and(eq(emailTokens.tokenHash, hashToken(token)), eq(emailTokens.purpose, purpose)),
    )
    .limit(1);

  if (!row || row.consumedAt !== null) {
    throw new AppError("invalid_token", "That link isn't valid. It may already be used.");
  }
  if (row.expiresAt <= new Date()) {
    throw new AppError("token_expired", "That link has expired.");
  }

  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
}

/**
 * Consumes a token atomically. The `consumedAt IS NULL` predicate lives in the
 * UPDATE's WHERE clause, so two concurrent requests with the same token cannot
 * both succeed — a check-then-update in application code would let them.
 */
export async function consumeEmailToken(
  tx: DbOrTx,
  token: string,
  purpose: Purpose,
): Promise<{ userId: string }> {
  const now = new Date();

  const updated = await tx
    .update(emailTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(emailTokens.tokenHash, hashToken(token)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.consumedAt),
      ),
    )
    .returning({ userId: emailTokens.userId, expiresAt: emailTokens.expiresAt });

  const row = updated[0];
  if (!row) {
    throw new AppError("invalid_token", "That link isn't valid. It may already be used.");
  }
  // Checked after the claim so an expired token is still burned rather than
  // left live for a retry.
  if (row.expiresAt <= now) {
    throw new AppError("token_expired", "That link has expired.");
  }

  return { userId: row.userId };
}
