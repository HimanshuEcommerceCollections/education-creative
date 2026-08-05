import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { encodeBase32LowerCaseNoPadding } from "@oslojs/encoding";

import { env } from "../env.ts";

/** 20 bytes → 32 base32 chars. Comfortably past any brute-force concern. */
const TOKEN_BYTES = 20;

/**
 * Generates an opaque bearer token. Base32 without padding keeps it
 * URL-safe and case-insensitive, which matters for the ones that end up in
 * emailed links.
 */
export function generateToken(): string {
  return encodeBase32LowerCaseNoPadding(randomBytes(TOKEN_BYTES));
}

/**
 * Hashes a token for storage. The pepper is an env secret and is *not* in the
 * database, so a stolen dump alone can't be used to forge a session lookup —
 * the attacker would also need the application's config.
 *
 * SHA-256 rather than Argon2 deliberately: these are 160-bit random values, not
 * low-entropy human passwords, so there is nothing to slow down a guesser
 * against, and this runs on every authenticated request.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(`${env.SESSION_PEPPER}:${token}`).digest("hex");
}

/** Constant-time comparison for two hex digests of equal length. */
export function tokensMatch(hashA: string, hashB: string): boolean {
  const a = Buffer.from(hashA, "hex");
  const b = Buffer.from(hashB, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** SHA-256 of arbitrary text, hex. Used for consent-copy hashes. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
