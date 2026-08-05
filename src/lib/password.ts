import { randomBytes, timingSafeEqual } from "node:crypto";

import { argon2idAsync } from "@noble/hashes/argon2.js";

/**
 * Argon2id password hashing.
 *
 * Uses the pure-JavaScript implementation from `@noble/hashes` rather than the
 * native `@node-rs/argon2`: Windows Application Control blocks the unsigned
 * `.node` binary on this project's development machines, and a dependency that
 * can't load isn't a dependency. The trade-off is speed — a derivation costs
 * roughly 3-5× a native one — which is why `asyncTick` is set: the async variant
 * yields to the event loop instead of blocking it for the whole derivation.
 *
 * OWASP's second recommended profile: 19 MiB, t=2, p=1.
 */
const PARAMS = { m: 19_456, t: 2, p: 1 } as const;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** Yield to the event loop this often (ms) while deriving. */
const ASYNC_TICK = 10;

const ALGORITHM = "argon2id";
const ARGON2_VERSION = 0x13;

/** Unpadded base64, as the PHC string format specifies. */
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

function fromB64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

async function derive(
  password: string,
  salt: Uint8Array,
  params: { m: number; t: number; p: number },
): Promise<Uint8Array> {
  return argon2idAsync(password, salt, {
    ...params,
    dkLen: HASH_BYTES,
    asyncTick: ASYNC_TICK,
  });
}

/**
 * Returns a PHC-format string:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`
 *
 * Encoding the parameters alongside the hash is what lets these numbers be
 * raised later without invalidating existing passwords — old hashes keep
 * verifying under the parameters they were created with.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, PARAMS);

  return `$${ALGORITHM}$v=${ARGON2_VERSION}$m=${PARAMS.m},t=${PARAMS.t},p=${PARAMS.p}$${b64(salt)}$${b64(hash)}`;
}

interface ParsedHash {
  params: { m: number; t: number; p: number };
  salt: Buffer;
  hash: Buffer;
}

function parsePhc(encoded: string): ParsedHash | null {
  // ["", "argon2id", "v=19", "m=…,t=…,p=…", salt, hash]
  const parts = encoded.split("$");
  if (parts.length !== 6) return null;
  if (parts[1] !== ALGORITHM) return null;
  if (parts[2] !== `v=${ARGON2_VERSION}`) return null;

  const params: Record<string, number> = {};
  for (const pair of parts[3]!.split(",")) {
    const [key, value] = pair.split("=");
    if (!key || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    params[key] = parsed;
  }
  if (!params.m || !params.t || !params.p) return null;

  const salt = fromB64(parts[4]!);
  const hash = fromB64(parts[5]!);
  if (salt.length === 0 || hash.length === 0) return null;

  return { params: { m: params.m, t: params.t, p: params.p }, salt, hash };
}

/**
 * Never throws on an absent or malformed hash — a corrupt row has to read as a
 * failed login, not a 500 that confirms to an attacker that the account exists.
 */
export async function verifyPassword(
  passwordHash: string | null,
  password: string,
): Promise<boolean> {
  if (!passwordHash) return false;

  const parsed = parsePhc(passwordHash);
  if (!parsed) return false;

  try {
    const candidate = await derive(password, parsed.salt, parsed.params);
    if (candidate.length !== parsed.hash.length) return false;
    return timingSafeEqual(Buffer.from(candidate), parsed.hash);
  } catch {
    return false;
  }
}

/**
 * Burns comparable CPU to a real verification. Called when the email doesn't
 * exist or the account has no password, so response timing can't be used to
 * enumerate accounts.
 */
export async function fakeVerifyDelay(): Promise<void> {
  await derive("timing-equalisation-placeholder", randomBytes(SALT_BYTES), PARAMS);
}
