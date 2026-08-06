/**
 * End-to-end check against a real database.
 *
 * Exercises the flows that only exist once Postgres is reachable: signup, the
 * single login page's role-based redirects, role precedence, the educator
 * application → approval → invite → set-password chain, password reset with
 * session revocation, and lockout.
 *
 * Email tokens are only stored hashed, so they can't be read back out of the
 * database. They're read from the console driver's outbox instead: start the API
 * with EMAIL_OUTBOX_FILE set, and point this script at the same path.
 *
 *   EMAIL_DRIVER=console EMAIL_OUTBOX_FILE=/tmp/outbox.jsonl npx tsx src/server.ts &
 *   EMAIL_OUTBOX_FILE=/tmp/outbox.jsonl npx tsx scripts/e2e.ts
 *
 * Safe to re-run: it namespaces every address with a timestamp passed in via
 * RUN_ID, so it never collides with a previous run's rows.
 */
import { readFileSync } from "node:fs";

// This script deliberately doesn't import src/env.ts (it talks to the API over
// HTTP and needs no server config), so it has to load .env itself to read the
// seeded admin credentials.
try {
  process.loadEnvFile();
} catch {
  // Values may come from the shell instead.
}

const API = process.env.E2E_API ?? "http://127.0.0.1:4100";
/**
 * The console driver's JSONL outbox. `LOG_FILE` is still honoured for the older
 * stdout-scraping approach, but the outbox is authoritative — redirected stdout
 * turned out not to reliably capture the driver's output.
 */
const OUTBOX_FILE = process.env.EMAIL_OUTBOX_FILE ?? process.env.LOG_FILE;
const RUN = process.env.RUN_ID ?? "local";

/**
 * Rate limits are keyed on the forwarded client IP, and the limiter is in-memory
 * with a 10-minute window — so a fixed address means the second run inside that
 * window is throttled and reports failures that are purely artefacts. Deriving
 * the last two octets from RUN_ID gives each run its own bucket.
 */
const runOctets = (() => {
  let hash = 0;
  for (const char of RUN) hash = (hash * 31 + char.charCodeAt(0)) % 65536;
  return [Math.floor(hash / 256), hash % 256];
})();
const CLIENT_IP = `203.0.113.${runOctets[1]}`;
const LOCKOUT_IP = `198.51.100.${runOctets[0]}`;

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@yourlearningjourney.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "";

const parentEmail = `parent.${RUN}@example.com`;
const educatorEmail = `educator.${RUN}@example.com`;
const PASSWORD = "a-strong-passphrase";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = "") {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n— ${title} —`);
}

interface Res<T> {
  status: number;
  body: T;
}

async function call<T = any>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; ip?: string } = {},
): Promise<Res<T>> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      // Rate limits are keyed on this. Tests that need a fresh bucket — notably
      // the lockout section, which must reach the account threshold before the
      // per-IP limit trips — pass their own address.
      "x-client-ip": init.ip ?? CLIENT_IP,
      "x-client-user-agent": "e2e-suite/1.0",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const raw = await response.text();
  let body: any = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON */
  }
  return { status: response.status, body };
}

/**
 * Newest link matching `pathPrefix` from the console driver's outbox.
 *
 * Reads the structured `links` array rather than regexing prose, and scans newest
 * first so a re-run picks up its own token and not a previous run's.
 */
function latestEmailLink(pathPrefix: string): string | null {
  if (!OUTBOX_FILE) return null;

  let contents: string;
  try {
    contents = readFileSync(OUTBOX_FILE, "utf8");
  } catch {
    return null;
  }

  const lines = contents.split("\n").filter((line) => line.trim().length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: { links?: string[] };
    try {
      entry = JSON.parse(lines[index]!);
    } catch {
      continue; // Not an outbox line — tolerate a stale stdout log.
    }
    const match = entry.links?.find((link) => link.includes(`${pathPrefix}?token=`));
    if (match) return match;
  }

  return null;
}

function tokenFrom(link: string | null): string | null {
  if (!link) return null;
  return new URL(link).searchParams.get("token");
}

// ---------------------------------------------------------------------------

section("health");
const health = await call("/healthz");
ok("GET /healthz returns 200", health.status === 200);

section("customer signup");
const signup = await call("/auth/signup", {
  body: {
    fullName: "Parent Tester",
    email: parentEmail.toUpperCase(), // must be normalised server-side
    password: PASSWORD,
    consentGiven: true,
    subjectsOfInterest: ["Music", "Music", "Cooking"], // duplicate must be deduped
  },
});
ok("signup returns 201", signup.status === 201, `status ${signup.status}`);
ok("email is normalised to lowercase", signup.body?.session?.user?.email === parentEmail);
ok("customer is redirected to the homepage", signup.body?.redirectTo === "/");
ok("session is issued and usable", typeof signup.body?.token === "string");
ok("email starts unverified", signup.body?.session?.user?.emailVerified === false);
ok("customer role granted", signup.body?.session?.roles?.[0] === "customer");

const dup = await call("/auth/signup", {
  body: { fullName: "Someone Else", email: parentEmail, password: PASSWORD, consentGiven: true },
});
ok("duplicate email is a 409, not a 500", dup.status === 409, `status ${dup.status}`);
ok("duplicate returns a field error on email", Boolean(dup.body?.error?.fieldErrors?.email));

const noConsent = await call("/auth/signup", {
  body: {
    fullName: "No Consent",
    email: `nc.${RUN}@example.com`,
    password: PASSWORD,
    consentGiven: false,
  },
});
ok("signup without consent is rejected", noConsent.status === 400);

section("login and session");
const login = await call("/auth/login", {
  body: { email: parentEmail, password: PASSWORD, rememberMe: true },
});
const parentToken: string = login.body?.token;
ok("login succeeds", login.status === 200 && login.body?.outcome === "authenticated");
ok("customer lands on the homepage", login.body?.redirectTo === "/");
ok(
  "remember-me extends the idle window past a week",
  new Date(login.body?.session?.idleExpiresAt).getTime() > Date.now() + 7 * 864e5,
);

const badPassword = await call("/auth/login", {
  body: { email: parentEmail, password: "wrong-password-here" },
});
const unknownEmail = await call("/auth/login", {
  body: { email: `ghost.${RUN}@example.com`, password: "wrong-password-here" },
});
ok("wrong password is 401", badPassword.status === 401);
ok(
  "unknown email is indistinguishable from a wrong password",
  unknownEmail.status === badPassword.status &&
    unknownEmail.body?.error?.message === badPassword.body?.error?.message,
);

const session = await call("/auth/session", { token: parentToken });
ok("session introspection works", session.status === 200);
ok("session reports fullyAuthenticated for a customer", session.body?.fullyAuthenticated === true);

const noToken = await call("/auth/session");
ok("session without a token is 401", noToken.status === 401);
const badToken = await call("/auth/session", { token: "not-a-real-token-value-at-all" });
ok("session with a bogus token is 401", badToken.status === 401);

section("email verification");
const verifyToken = tokenFrom(latestEmailLink("/verify-email"));
if (verifyToken) {
  const verified = await call("/auth/verify-email", { body: { token: verifyToken } });
  ok("verification token is accepted", verified.status === 200);
  const replay = await call("/auth/verify-email", { body: { token: verifyToken } });
  ok("verification token is single-use", replay.status === 400, `status ${replay.status}`);
  const after = await call("/auth/session", { token: parentToken });
  ok("session now reports the email as verified", after.body?.user?.emailVerified === true);
} else {
  ok("verification link captured from the email driver", false, "set EMAIL_OUTBOX_FILE on both the API and this script");
}

section("staff login and the review queue");
const adminLogin = await call("/auth/login", {
  body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, rememberMe: true },
});
const adminToken: string = adminLogin.body?.token;
ok("seeded admin can sign in", adminLogin.status === 200, `status ${adminLogin.status}`);
ok("admin lands on the dashboard", adminLogin.body?.redirectTo === "/dashboard");
ok("admin session is flagged staff", adminLogin.body?.session?.isStaff === true);
ok(
  "remember-me is ignored for staff (idle stays short)",
  new Date(adminLogin.body?.session?.idleExpiresAt).getTime() < Date.now() + 2 * 3600e3,
  `idle ${adminLogin.body?.session?.idleExpiresAt}`,
);

const queueAsCustomer = await call("/educator-applications", { token: parentToken });
ok("a customer cannot read the staff queue", queueAsCustomer.status === 403);

section("educator application → approval → invite");
const application = await call("/educator-applications", {
  body: {
    applicantName: "Educator Tester",
    email: educatorEmail,
    subjectsOfInterest: ["music"],
    yearsExperience: "3-5",
    about:
      "I have taught piano and music theory to school-age learners for several years and enjoy beginners most.",
  },
});
ok("public application is accepted", application.status === 202, `status ${application.status}`);

const shortBio = await call("/educator-applications", {
  body: {
    applicantName: "Too Terse",
    email: `terse.${RUN}@example.com`,
    subjectsOfInterest: ["music"],
    about: "hi",
  },
});
ok("a too-short bio is rejected", shortBio.status === 400);

const loginAsApplicant = await call("/auth/login", {
  body: { email: educatorEmail, password: PASSWORD },
});
ok(
  "an applicant has no account to sign in with",
  loginAsApplicant.status === 401,
  `status ${loginAsApplicant.status}`,
);

const queue = await call("/educator-applications?status=submitted&limit=50", {
  token: adminToken,
});
ok("staff can read the queue", queue.status === 200);
const mine = queue.body?.items?.find((item: any) => item.email === educatorEmail);
ok("the new application appears in the queue", Boolean(mine));

const approved = await call(`/educator-applications/${mine?.id}/approve`, {
  method: "POST",
  token: adminToken,
  body: { backgroundCheckRef: "persona_e2e_pass" },
});
ok("approval succeeds", approved.status === 200, JSON.stringify(approved.body).slice(0, 200));
ok("approval creates a user", typeof approved.body?.userId === "string");
ok("approval creates an educator profile", typeof approved.body?.educatorProfileId === "string");

const reApprove = await call(`/educator-applications/${mine?.id}/approve`, {
  method: "POST",
  token: adminToken,
  body: {},
});
ok("re-approving is rejected", reApprove.status === 409, `status ${reApprove.status}`);

const inviteToken = tokenFrom(latestEmailLink("/accept-invite"));
if (inviteToken) {
  const peek = await call(`/auth/invite?token=${encodeURIComponent(inviteToken)}`);
  ok("invite can be read without consuming it", peek.status === 200);
  ok("invite names the educator role", peek.body?.role === "educator");
  ok("invite carries the applicant's email", peek.body?.email === educatorEmail);

  const stillInvited = await call("/auth/login", {
    body: { email: educatorEmail, password: PASSWORD },
  });
  ok(
    "an invited account cannot sign in before setting a password",
    stillInvited.status === 401,
    `status ${stillInvited.status}`,
  );

  const noAttest = await call("/auth/accept-invite", {
    body: { token: inviteToken, password: PASSWORD, attestAdult: false },
  });
  ok("accepting without the adult attestation is rejected", noAttest.status === 400);

  const accepted = await call("/auth/accept-invite", {
    body: { token: inviteToken, password: PASSWORD, attestAdult: true },
  });
  ok("invite acceptance succeeds", accepted.status === 201, `status ${accepted.status}`);
  ok("educator lands on their dashboard", accepted.body?.redirectTo === "/educator");
  ok("educator active role is educator", accepted.body?.session?.activeRole === "educator");
  ok("invite acceptance marks the email verified", accepted.body?.session?.user?.emailVerified === true);

  const replayInvite = await call("/auth/accept-invite", {
    body: { token: inviteToken, password: PASSWORD, attestAdult: true },
  });
  ok("invite token is single-use", replayInvite.status === 400, `status ${replayInvite.status}`);

  const educatorLogin = await call("/auth/login", {
    body: { email: educatorEmail, password: PASSWORD },
  });
  ok("educator can now sign in normally", educatorLogin.status === 200);
  ok("educator is routed to /educator", educatorLogin.body?.redirectTo === "/educator");
  ok("educator is not staff", educatorLogin.body?.session?.isStaff === false);

  const educatorQueue = await call("/educator-applications", {
    token: educatorLogin.body?.token,
  });
  ok("an educator cannot read the staff queue", educatorQueue.status === 403);
} else {
  ok("invite link captured from the email driver", false, "set EMAIL_OUTBOX_FILE on both the API and this script");
}

section("password reset revokes every session");
const reset = await call("/auth/forgot-password", { body: { email: parentEmail } });
ok("forgot-password always returns 200", reset.status === 200);
const unknownReset = await call("/auth/forgot-password", {
  body: { email: `ghost2.${RUN}@example.com` },
});
ok(
  "forgot-password reply is identical for an unknown address",
  unknownReset.status === reset.status && unknownReset.body?.message === reset.body?.message,
);

const resetToken = tokenFrom(latestEmailLink("/reset-password"));
if (resetToken) {
  const beforeReset = await call("/auth/session", { token: parentToken });
  ok("the old session is alive before the reset", beforeReset.status === 200);

  const applied = await call("/auth/reset-password", {
    body: { token: resetToken, password: "an-even-better-passphrase" },
  });
  ok("reset succeeds", applied.status === 200, `status ${applied.status}`);

  const afterReset = await call("/auth/session", { token: parentToken });
  ok(
    "every pre-existing session is revoked by the reset",
    afterReset.status === 401,
    `status ${afterReset.status}`,
  );

  const oldPassword = await call("/auth/login", { body: { email: parentEmail, password: PASSWORD } });
  ok("the old password no longer works", oldPassword.status === 401);
  const newPassword = await call("/auth/login", {
    body: { email: parentEmail, password: "an-even-better-passphrase" },
  });
  ok("the new password works", newPassword.status === 200);
} else {
  ok("reset link captured from the email driver", false, "set EMAIL_OUTBOX_FILE on both the API and this script");
}

section("logout");
const logoutLogin = await call("/auth/login", {
  body: { email: parentEmail, password: "an-even-better-passphrase" },
});
const logoutToken = logoutLogin.body?.token;
const loggedOut = await call("/auth/logout", { method: "POST", token: logoutToken });
ok("logout returns 200", loggedOut.status === 200);
const afterLogout = await call("/auth/session", { token: logoutToken });
ok("the token is dead after logout", afterLogout.status === 401);

section("account lockout");
const lockEmail = `lockout.${RUN}@example.com`;
// A dedicated address so this section starts with an unused rate-limit bucket;
// otherwise the per-IP limit trips before the account threshold is reached and
// the lockout path never runs.
const lockIp = LOCKOUT_IP;
await call("/auth/signup", {
  body: { fullName: "Lock Target", email: lockEmail, password: PASSWORD, consentGiven: true },
  ip: lockIp,
});
let lockedAt = 0;
let rateLimitedAt = 0;
for (let attempt = 1; attempt <= 9; attempt += 1) {
  const result = await call("/auth/login", {
    body: { email: lockEmail, password: `wrong-${attempt}` },
    ip: lockIp,
  });
  if (result.status === 423 && lockedAt === 0) lockedAt = attempt;
  if (result.status === 429 && rateLimitedAt === 0) rateLimitedAt = attempt;
}
ok(
  "repeated failures lock the account",
  lockedAt > 0,
  `locked on attempt ${lockedAt}${rateLimitedAt ? `, rate-limited from ${rateLimitedAt}` : ""}`,
);
const lockedWithGoodPassword = await call("/auth/login", {
  body: { email: lockEmail, password: PASSWORD },
  ip: lockIp,
});
ok(
  "the lock holds even for the correct password",
  lockedWithGoodPassword.status === 423,
  `status ${lockedWithGoodPassword.status}`,
);

console.log(
  failures === 0
    ? `\nAll ${checks} checks passed.\n`
    : `\n${failures} of ${checks} checks failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
