/**
 * Boot-and-contract smoke check. Runs without a database: it exercises health,
 * validation, and auth-gate behaviour, all of which short-circuit before any
 * query. Useful for confirming wiring before `DATABASE_URL` is real.
 *
 *   npx tsx scripts/smoke.ts
 */
import type { InjectOptions } from "fastify";

import { buildApp } from "../src/app.ts";

const app = await buildApp();

let failures = 0;

async function check(
  label: string,
  request: InjectOptions,
  expectedStatus: number,
  expectedCode?: string,
) {
  const response = await app.inject(request);
  const body = response.json() as { error?: { code?: string } };
  const code = body?.error?.code;
  const ok = response.statusCode === expectedStatus && (!expectedCode || code === expectedCode);

  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n      → ${response.statusCode}${code ? ` ${code}` : ""}` +
      (ok ? "" : `  (expected ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ""})`),
  );
  if (!ok) console.log(`      body: ${JSON.stringify(body).slice(0, 300)}`);
}

console.log("\n— health —");
await check("GET /healthz", { method: "GET", url: "/healthz" }, 200);

console.log("\n— validation runs before any database access —");
await check(
  "signup rejects a short password",
  {
    method: "POST",
    url: "/auth/signup",
    payload: {
      fullName: "Test Parent",
      email: "parent@example.com",
      password: "short",
      consentGiven: true,
    },
  },
  400,
  "validation_failed",
);
await check(
  "signup rejects missing consent (the COPPA gate)",
  {
    method: "POST",
    url: "/auth/signup",
    payload: {
      fullName: "Test Parent",
      email: "parent@example.com",
      password: "a-long-enough-password",
      consentGiven: false,
    },
  },
  400,
  "validation_failed",
);
await check(
  "signup rejects unknown fields (.strict)",
  {
    method: "POST",
    url: "/auth/signup",
    payload: {
      fullName: "Test Parent",
      email: "parent@example.com",
      password: "a-long-enough-password",
      consentGiven: true,
      isAdmin: true,
    },
  },
  400,
  "validation_failed",
);
await check(
  "login rejects a malformed email",
  { method: "POST", url: "/auth/login", payload: { email: "nope", password: "x" } },
  400,
  "validation_failed",
);
await check(
  "educator application rejects a too-short bio",
  {
    method: "POST",
    url: "/educator-applications",
    payload: {
      applicantName: "Test Educator",
      email: "educator@example.com",
      subjectsOfInterest: ["music"],
      about: "too short",
    },
  },
  400,
  "validation_failed",
);

console.log("\n— auth gates reject before touching the database —");
await check(
  "GET /auth/session without a token",
  { method: "GET", url: "/auth/session" },
  401,
  "unauthenticated",
);
await check(
  "GET /auth/session with a malformed header",
  { method: "GET", url: "/auth/session", headers: { authorization: "Basic abc" } },
  401,
  "unauthenticated",
);
await check(
  "staff review queue without a token",
  { method: "GET", url: "/educator-applications" },
  401,
  "unauthenticated",
);

console.log("\n— unknown routes —");
await check("GET /nope", { method: "GET", url: "/nope" }, 404, "not_found");

await app.close();

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
