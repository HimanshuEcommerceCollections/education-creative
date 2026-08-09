/** One-off verification of the crypto primitives. Not part of the build. */
import { hashPassword, verifyPassword, fakeVerifyDelay } from "../src/lib/password.ts";
import { encryptField, decryptField } from "../src/lib/crypto-field.ts";
import { generateToken, hashToken, tokensMatch, sha256Hex } from "../src/lib/tokens.ts";
import { uuidv7 } from "../src/lib/id.ts";
import { resolveActiveRole, homeForRole } from "../src/contracts/roles.ts";

let fail = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
};

const t0 = Date.now();
const hash = await hashPassword("correct horse battery staple");
const hashMs = Date.now() - t0;
ok("argon2id produces a PHC string", hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"), hash.slice(0, 40));
console.log(`      hash cost: ${hashMs}ms`);

const t1 = Date.now();
ok("correct password verifies", await verifyPassword(hash, "correct horse battery staple"));
console.log(`      verify cost: ${Date.now() - t1}ms`);
ok("wrong password rejected", !(await verifyPassword(hash, "wrong password here")));
ok("null hash rejected without throwing", !(await verifyPassword(null, "anything")));
ok("garbage hash rejected without throwing", !(await verifyPassword("$argon2id$nonsense", "x")));
ok("two hashes of the same password differ (salted)", (await hashPassword("same")) !== (await hashPassword("same")));
const t2 = Date.now();
await fakeVerifyDelay();
console.log(`      timing-equalisation cost: ${Date.now() - t2}ms`);

const secret = "learner in-home address, 12 Elm St";
const enc = encryptField(secret);
ok("field encryption round-trips", decryptField(enc) === secret);
ok("field ciphertext differs per call", encryptField(secret) !== encryptField(secret));
let tamperCaught = false;
try { decryptField(enc.slice(0, -4) + "AAAA"); } catch { tamperCaught = true; }
ok("tampered ciphertext throws (GCM auth tag)", tamperCaught);

const tok = generateToken();
ok("session token is base32, 32 chars", /^[a-z2-7]{32}$/.test(tok), tok);
ok("token hash is stable", hashToken(tok) === hashToken(tok));
ok("token hashes are unique per token", hashToken(tok) !== hashToken(generateToken()));
ok("tokensMatch is true for equal digests", tokensMatch(hashToken(tok), hashToken(tok)));
ok("tokensMatch is false for different digests", !tokensMatch(hashToken(tok), hashToken(generateToken())));
ok("sha256Hex is 64 hex chars", /^[0-9a-f]{64}$/.test(sha256Hex("consent copy")));

const ids = Array.from({ length: 200 }, uuidv7);
ok("uuidv7 sets version 7", ids.every((id) => id[14] === "7"));
ok("uuidv7 sets the RFC variant", ids.every((id) => "89ab".includes(id[19]!)));
ok("uuidv7 values are unique", new Set(ids).size === ids.length);
// UUIDv7 orders across milliseconds, not within one (no monotonic counter),
// so sample with a gap rather than asserting on a same-millisecond batch.
const spaced = [];
for (let i = 0; i < 5; i++) { spaced.push(uuidv7()); await new Promise((r) => setTimeout(r, 3)); }
ok("uuidv7 is time-ordered across milliseconds", [...spaced].sort().join() === spaced.join());

ok("multi-role resolves to highest privilege", resolveActiveRole(["customer", "educator", "admin"]) === "admin");
ok("coordinator beats educator", resolveActiveRole(["educator", "coordinator"]) === "coordinator");
ok("parent-who-teaches resolves to educator", resolveActiveRole(["customer", "educator"]) === "educator");
ok("no roles resolves to null", resolveActiveRole([]) === null);
ok("customer lands on the homepage", homeForRole("customer") === "/");
ok("educator lands on their dashboard", homeForRole("educator") === "/educator");
ok("admin and coordinator share the dashboard", homeForRole("admin") === homeForRole("coordinator"));

console.log(fail === 0 ? "\nAll crypto/contract checks passed.\n" : `\n${fail} failed.\n`);
process.exit(fail ? 1 : 0);
