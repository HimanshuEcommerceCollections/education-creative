/**
 * Verifies the multi-role decision end to end: a user holding several roles gets
 * the highest-privilege one as their session's active role and redirect target.
 *
 * Needs direct database access to grant roles (there's no role-grant endpoint
 * yet — that's admin work in a later phase), so it's separate from `e2e.ts`.
 *
 *   npx tsx scripts/e2e-multirole.ts
 */
import { and, eq, isNull, sql as rawSql } from "drizzle-orm";

import type { UserRole } from "../src/contracts/roles.ts";
import { closeDatabase, db } from "../src/db/client.ts";
import { userRoles, users } from "../src/db/schema/index.ts";

const API = process.env.E2E_API ?? "http://127.0.0.1:4100";
const RUN = process.env.RUN_ID ?? `mr${Date.now()}`;
const email = `multirole.${RUN}@example.com`;
const PASSWORD = "a-strong-passphrase";

let failures = 0;
const ok = (label: string, condition: boolean, detail = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

async function post(path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-client-ip": "198.51.100.99" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const signup = await post("/auth/signup", {
  fullName: "Multi Role",
  email,
  password: PASSWORD,
  consentGiven: true,
});
ok("customer signup", signup.status === 201, `status ${signup.status}`);
ok("starts as a customer on the homepage", signup.body?.redirectTo === "/");

const [user] = await db
  .select({ id: users.id })
  .from(users)
  .where(and(rawSql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
  .limit(1);

if (!user) {
  console.log("FAIL  could not find the created user");
  await closeDatabase();
  process.exit(1);
}

async function grant(role: UserRole) {
  await db.insert(userRoles).values({ userId: user!.id, role }).onConflictDoNothing();
}

async function loginRedirect() {
  const result = await post("/auth/login", { email, password: PASSWORD });
  return {
    redirectTo: result.body?.redirectTo as string,
    activeRole: result.body?.session?.activeRole as string,
    roles: (result.body?.session?.roles ?? []) as string[],
    isStaff: result.body?.session?.isStaff as boolean,
  };
}

// The parent-who-also-teaches case ARCHITECTURE.md §4 calls out explicitly.
await grant("educator");
const asEducator = await loginRedirect();
ok(
  "customer + educator resolves to educator",
  asEducator.activeRole === "educator" && asEducator.redirectTo === "/educator",
  `${asEducator.activeRole} → ${asEducator.redirectTo}`,
);
ok("both roles are still reported", asEducator.roles.length === 2);
ok("educator is not staff", asEducator.isStaff === false);

await grant("coordinator");
const asCoordinator = await loginRedirect();
ok(
  "adding coordinator promotes the active role",
  asCoordinator.activeRole === "coordinator" && asCoordinator.redirectTo === "/dashboard",
  `${asCoordinator.activeRole} → ${asCoordinator.redirectTo}`,
);
ok("coordinator is staff", asCoordinator.isStaff === true);

await grant("admin");
const asAdmin = await loginRedirect();
ok(
  "admin outranks everything",
  asAdmin.activeRole === "admin" && asAdmin.redirectTo === "/dashboard",
  `${asAdmin.activeRole} → ${asAdmin.redirectTo}`,
);
ok("all four roles are reported", asAdmin.roles.length === 4, asAdmin.roles.join(", "));

// A session whose active role is revoked mid-flight must stop working, not
// silently keep the privilege it was minted with.
const staffSession = await post("/auth/login", { email, password: PASSWORD });
const staffToken = staffSession.body?.token as string;
await db.delete(userRoles).where(and(eq(userRoles.userId, user.id), eq(userRoles.role, "admin")));

const afterRevoke = await fetch(`${API}/auth/session`, {
  headers: { Authorization: `Bearer ${staffToken}` },
});
ok(
  "revoking the active role invalidates the session",
  afterRevoke.status === 401,
  `status ${afterRevoke.status}`,
);

const reLogin = await loginRedirect();
ok(
  "re-login falls back to the next-highest role",
  reLogin.activeRole === "coordinator",
  reLogin.activeRole,
);

console.log(failures === 0 ? "\nAll multi-role checks passed.\n" : `\n${failures} failed.\n`);
await closeDatabase();
process.exit(failures === 0 ? 0 : 1);
