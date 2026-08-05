import { generateSecret, generateURI, verify } from "otplib";

import { SITE_NAME } from "../constants.ts";
import { decryptField, encryptField } from "./crypto-field.ts";

/**
 * Staff second factor. Secrets are stored encrypted (`users.mfaSecret`), so
 * enrolling returns the only plaintext copy the server will ever produce.
 */
export function createTotpSecret(): string {
  return generateSecret();
}

export function encryptTotpSecret(secret: string): string {
  return encryptField(secret);
}

export function buildTotpUri(secret: string, accountEmail: string): string {
  return generateURI({ issuer: SITE_NAME, label: accountEmail, secret });
}

/**
 * Verifies a 6-digit code. A 30-second tolerance accepts the adjacent window in
 * each direction, which covers ordinary clock drift without meaningfully
 * widening the guessing window (rate limiting does that job).
 *
 * Returns false rather than throwing if the stored secret can't be decrypted, so
 * a key-rotation mistake reads as a failed code instead of a 500.
 */
export async function verifyTotpCode(
  encryptedSecret: string | null,
  code: string,
): Promise<boolean> {
  if (!encryptedSecret) return false;

  let secret: string;
  try {
    secret = decryptField(encryptedSecret);
  } catch {
    return false;
  }

  try {
    const result = await verify({ secret, token: code, epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
}
