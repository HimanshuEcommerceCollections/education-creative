import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../env.ts";

/**
 * AES-256-GCM application-level encryption for the few columns that hold a
 * minor's PII — learner first names and in-home addresses (§9). Used by the TOTP
 * secret too, so a database dump doesn't hand over staff second factors.
 *
 * Launch scope is a single key held in the secrets broker; per-record envelope
 * encryption is the documented hardening follow-up. The version prefix is what
 * makes that migration possible without a flag day.
 */
const KEY = Buffer.from(env.FIELD_ENCRYPTION_KEY, "base64");
const IV_BYTES = 12;
const VERSION = "v1";

/** Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Throws on a tampered or truncated value rather than returning a partial
 * plaintext — GCM's auth tag makes that detectable and it must not be ignored.
 */
export function decryptField(encoded: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unrecognised encrypted field format");
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];

  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Crypto-shredding helper: nulls readable content without dropping the row. */
export function isEncryptedField(value: string): boolean {
  return value.startsWith(`${VERSION}.`);
}
