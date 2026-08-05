import { randomBytes } from "node:crypto";

/**
 * UUIDv7 — a 48-bit big-endian millisecond timestamp followed by 74 random
 * bits. Generated in the application rather than the database because Postgres
 * only gained a native `uuidv7()` in 18, and Neon/Render may run older.
 *
 * Time-ordered PKs keep index inserts append-mostly and make `ORDER BY id` a
 * usable creation order, which matters for the append-only audit log.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();

  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 in the high nibble of octet 6, RFC 9562 variant in octet 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}
