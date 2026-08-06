# Server — Node API

Fastify + TypeScript + PostgreSQL (Drizzle). The **single identity authority and
sole enforcement point** for the platform. The browser never calls this service:
the Next.js app talks to it server-to-server and holds the session in a
first-party HttpOnly cookie (the BFF model).

## Repository layout

The web app is a **separate repository**
([education-creative-ui](https://github.com/HimanshuEcommerceCollections/education-creative-ui)),
and it imports the shared Zod contracts from `src/contracts/` in this one. Clone
them as siblings, with these exact directory names:

```
education-creative/
  client/   <- education-creative-ui.git
  server/   <- this repo
```

The web app's `scripts/sync-contracts.mjs` copies `server/src/contracts` into its
own tree on every `predev`/`prebuild`. Two consequences worth knowing:

- **`src/contracts/` is a published interface.** Editing it changes the web app's
  compile-time types. Land contract changes here first, then re-sync there.
- Nothing in `src/contracts/` may import from `../db`, `../services`, or `../env`
  — those files get bundled into a browser build.

The architecture document (`docs/ARCHITECTURE.md`) lives outside both repos, in the
workspace root.

## Getting started

```bash
npm install
# 1. Put your Neon/Render connection string in .env (DATABASE_URL)
npm run db:migrate        # apply drizzle/*.sql
npm run seed:admin        # create the first admin from SEED_ADMIN_* in .env
npm run dev               # http://localhost:4100
```

`npm run db:generate` regenerates migration SQL from the schema and works offline —
it never connects. `db:migrate` and `db:studio` need a live database.

Port 4100, not 4000, because another local project already holds 4000. If you
change `PORT`, change `API_BASE_URL` in `client/.env.local` to match.

## Deploying to Vercel

`src/server.ts` runs a listening process (`npm run dev`, or a container on
Render/Fly/Railway). Vercel invokes a function per request instead, so `api/index.ts`
is a second entry point that hands raw requests to Fastify without ever calling
`listen()`. `vercel.json` rewrites every path to it. Both entry points share the
same `buildApp()`, so there is one application, not two.

```bash
vercel switch ecommerce-collections   # pick the right scope
vercel link                            # from this directory
# set the env vars below, then:
vercel deploy --prod
```

Environment variables to set on the project:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's **pooled** string (the `-pooler` host) |
| `WEB_ORIGIN` | the Next app's URL |
| `SESSION_PEPPER` | fresh 32+ chars, not the development one |
| `FIELD_ENCRYPTION_KEY` | fresh 32 bytes base64 |
| `MFA_REQUIRED` | `true` (boot refuses `false` in production) |
| `EMAIL_DRIVER` | `resend` or `ses` — **not `smtp`**, see below |
| `RESEND_API_KEY` / `AWS_*` | whichever the driver needs |
| `EMAIL_FROM` | your sending identity |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | from an Upstash database |

`NODE_ENV` is set by Vercel. Don't set `PORT`. Leave `SEED_ADMIN_*` off the
platform — there's no shell on serverless, so bootstrap the first admin by running
`npm run seed:admin` locally with `DATABASE_URL` pointed at production.

Three constraints that come with serverless, all enforced at boot so they can't be
missed:

1. **`EMAIL_DRIVER=smtp` will not work.** Vercel blocks outbound SMTP ports, so
   Gmail times out. Use `resend` or `ses` — both HTTPS on 443. Gmail stays fine for
   local development; the driver is per-environment config.
2. **Rate limiting needs Upstash.** Every request may hit a fresh instance, so an
   in-process counter protects nothing. Production boot fails without it.
3. **Use the pooled database endpoint.** A connection per invocation exhausts a
   direct endpoint; `db/client.ts` also disables prepared statements automatically
   when it sees a `-pooler` host, since PgBouncer in transaction mode can't hold them.

Still not viable on serverless, and unchanged by this: **pg-boss background jobs**
(the SLA auto-refund timer, nightly Stripe reconciliation, retention purges) need a
persistent process. Phase 4 will need a worker somewhere regardless of where the
API lives.

## Email

Business logic only ever sees the `EmailService` interface, so the provider is a
config choice. `EMAIL_DRIVER` selects one of four:

| Driver | Transport | Use it for |
|---|---|---|
| `console` | none — prints to stdout | Local development. Verification and invite links appear in the terminal, so flows can be completed without an inbox. Rejected in production. |
| `smtp` | SMTP (587/465) | **Gmail** (current), plus SES-over-SMTP, Mailgun, Brevo, Postmark, Mailpit |
| `resend` | HTTPS (443) | Resend's REST API |
| `ses` | HTTPS (443) | AWS SES v2 API |

Each provider's SDK is imported lazily inside its driver, so choosing Gmail never
loads the AWS SDK, and vice versa. Adding a provider is one file implementing
`EmailService` plus one case in the factory — nothing else needs to know.

### Gmail setup

```
EMAIL_DRIVER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@gmail.com
SMTP_PASSWORD=<16-character App Password>
EMAIL_FROM="Your Learning Journey <you@gmail.com>"
```

Four things that trip people up, all of which the config now handles or explains:

1. **`SMTP_PASSWORD` must be an App Password**, not your Google password — create
   one at <https://myaccount.google.com/apppasswords> (needs 2-Step Verification).
   Google displays it in groups of four; the spaces are stripped for you.
2. **`EMAIL_FROM` must be the same address as `SMTP_USER`.** Gmail rewrites or
   rejects anything else.
3. **Port and TLS must agree** — 587 with `SMTP_SECURE=false`, 465 with `true`.
   Boot fails if they disagree, rather than hanging on connect.
4. **Limits:** roughly 500 messages/day on consumer Gmail, 2,000 on Workspace.
   Fine for launch volume; move to SES or Resend before it isn't.

**Gmail SMTP needs outbound 587/465, which some hosts block** — Render's free tier
among them. If deployment hits that wall, switch `EMAIL_DRIVER` to `resend` or
`ses`; both use HTTPS on 443 and need no code changes.

Test the configuration before trusting it:

```bash
npm run email:test                      # authenticate only, sends nothing
npm run email:test -- you@example.com   # then send a real message
```

It distinguishes bad credentials from a blocked port from a rejected sender, and
prints the fix for each.

## Checks

No database needed:

```bash
npx tsx scripts/env-check.ts        # env contract: drivers, prod guards  (22 checks)
npx tsx scripts/rate-limit-check.ts # limiter windows, isolation, fail-open (9 checks)
npx tsx scripts/smoke.ts            # boot, validation, auth gates         (10 checks)
npx tsx scripts/crypto-check.ts     # argon2 / TOTP / encryption / roles   (31 checks)
```

`smoke` and `crypto-check` boot the real config, so run them with
`EMAIL_DRIVER=console` if your SMTP credentials aren't filled in yet.

Against a real database. Verification, invite, and reset tokens are stored only as
hashes, so the suite reads them from the console driver's **outbox** — the API and
the script must point at the same file:

```bash
OUTBOX=/tmp/outbox.jsonl
EMAIL_DRIVER=console EMAIL_OUTBOX_FILE=$OUTBOX npx tsx src/server.ts > /tmp/api.log 2>&1 &
RUN_ID=$(date +%s) EMAIL_OUTBOX_FILE=$OUTBOX npx tsx scripts/e2e.ts   # 61 checks
RUN_ID=$(date +%s) npx tsx scripts/e2e-multirole.ts                   # 11 checks
```

`EMAIL_OUTBOX_FILE` makes the console driver append every message to a JSONL file.
It writes live tokens in plaintext, so production boot rejects it. Earlier versions
scraped the API's redirected stdout instead, which turned out not to capture the
driver's output reliably — the outbox is authoritative.

Always pass `RUN_ID`. It namespaces the rows *and* derives a per-run client IP, so
consecutive runs don't share the in-memory rate limiter's 10-minute bucket and
report throttling as failures.

`e2e.ts` covers signup, the single login page's role-based redirects, email
verification, the educator application → approval → invite → set-password chain,
password reset with session revocation, logout, and lockout. `e2e-multirole.ts`
covers highest-privilege-wins and mid-session role revocation.

Both write real rows. Point them at a scratch database, not production.

**Note on overrides:** a real environment variable beats `.env`, so
`EMAIL_DRIVER=console npm run …` does what it looks like. That precedence is
restored explicitly in `env.ts` — Node's `process.loadEnvFile()` overwrites
existing values, which would otherwise let a checked-out `.env` silently override
what a host injected.

## Roles

Four stored roles: `admin`, `coordinator`, `educator`, `customer`. `guest` is not
a row — it is the absence of a session.

| Role | How the account is created | Post-login destination |
|---|---|---|
| `customer` | public `POST /auth/signup` | `/` |
| `educator` | application → staff approval → invite → set password | `/educator` |
| `coordinator` | invite only, no public route | `/dashboard` |
| `admin` | invite only; first one via `npm run seed:admin` | `/dashboard` |

**One `/login` for every role.** This deliberately overrides §4's separate
`/staff/login`, so the protections that route used to imply are derived from the
role instead:

- Staff idle window is 45 minutes and **"Remember me" is ignored server-side**
  (`SESSION_POLICY` in `src/constants.ts`).
- Staff TOTP is a second step in the same flow. A staff session exists after the
  password check but `mfa_satisfied_at` is null, and `requireFullAuth` **fails
  closed** on it — the cookie is set but authorises nothing.
- Multi-role users resolve to their highest privilege
  (`admin > coordinator > educator > customer`), pinned onto `sessions.active_role`
  for the session's life. `resolveActiveRole` in `src/contracts/roles.ts`.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz` | public |
| POST | `/auth/signup` | public (customers only) |
| POST | `/auth/login` | public (all roles) |
| GET | `/auth/session` | session |
| POST | `/auth/logout` · `/auth/logout-everywhere` | session |
| GET | `/auth/mfa/setup` | session (pre-MFA) |
| POST | `/auth/mfa/enrol` · `/auth/mfa/verify` | session (pre-MFA) |
| POST | `/auth/verify-email` · `/auth/resend-verification` | public |
| POST | `/auth/forgot-password` · `/auth/reset-password` | public |
| GET | `/auth/invite?token=…` | public (read-only peek) |
| POST | `/auth/accept-invite` | public (token is the credential) |
| POST | `/educator-applications` | public |
| GET | `/educator-applications` · `/:id` | staff |
| PATCH | `/educator-applications/:id/review` | staff |
| POST | `/educator-applications/:id/approve` | staff |

Every route returns the session **token in the response body**, never a cookie —
cookie ownership belongs entirely to the Next BFF.

Failures share one envelope so the client can switch on a code rather than match
message strings:

```json
{ "error": { "code": "invalid_credentials", "message": "…", "fieldErrors": { "email": "…" } } }
```

## Things that are load-bearing

- **`src/contracts/` is the shared contract.** The Next app imports it, so
  password rules, role precedence, consent copy, and error codes have one
  definition. Nothing in there may import `../db`, `../services`, or `../env` —
  it must stay safe for a browser bundle.
- **Consent is hashed from the server's own copy** (`src/contracts/consent.ts`),
  never from request text, and is written in the same transaction as the user. An
  account cannot exist without the consent record that justifies it.
- **Only token hashes are stored**, peppered with `SESSION_PEPPER`. A database
  dump alone yields no usable session or reset link.
- **Educator applications create no account.** That is what makes "educators can
  never self-create an active account" structural rather than procedural. A
  pending or rejected applicant has nothing to sign in with and is notified by
  email.
- **Approval is its own endpoint**, not a status value on `/review`, because it
  creates a user, grants a role, creates a profile, and sends an invite.
- **Password reset revokes every session** for that account.
- **`audit_log` is append-only by intent but not yet by grant** — see below.

## Deviations from the architecture document

`docs/ARCHITECTURE.md` is not in this repo (see *Repository layout* above), so these
are recorded here for anyone reading the code without it to hand.

| Doc | Here | Why |
|---|---|---|
| `client` role, `client_profiles` | `customer`, `customer_profiles` | `client` collides with the `client/` frontend directory |
| separate `/staff/login` | one `/login` | product decision; staff protections became role-derived |
| `citext` email column | `text` + unique index on `lower(email)` | same case-insensitive guarantee, no extension dependency |
| `educator_applications.invite_token_hash` | `email_tokens` with `purpose='invite'` | verification, reset, and invite share one issue/consume path |
| Oslo for session tokens | `node:crypto` + `@oslojs/encoding` for base32 | only the encoding was actually needed |
| `apps/api` in a pnpm workspace | `server/` | matches the existing repo layout |

## Known gaps before this is production-ready

1. **No Turnstile on the auth forms.** Rate limiting and per-account lockout are in
   place, but nothing raises the cost of a distributed attempt from many addresses.
2. **`audit_log` needs a grant.** The code never issues UPDATE/DELETE on it, but
   that is not the same guarantee as the database role being unable to. After the
   first migration, run:
   ```sql
   REVOKE UPDATE, DELETE ON audit_log FROM <app_role>;
   ```
3. **Argon2id is the pure-JS implementation** (`@noble/hashes`), because Windows
   Application Control blocks `@node-rs/argon2`'s native binary on the dev
   machines. Costs ~480ms per hash instead of ~40ms. Hashes are written in
   standard PHC format precisely so production on Linux can switch to the native
   package with no password invalidation.
4. **No pg-boss jobs** (so no expired-session sweeper yet), no Redis response cache
   — Redis is used for rate limiting only — no Sentry, and no Google OAuth.
5. **Email sends are not retried.** A provider outage during signup means the
   account is created but the verification email is lost — deliberately, so a
   provider failure can't roll back an account. Recovery today is the
   "resend confirmation" path on `/account`; a durable outbox belongs with pg-boss.
6. **The checks are scripts, not a test suite.** They assert real behaviour and
   pass, but there's no runner, no CI wiring, and no fixture teardown.
7. **`drizzle-kit` pulls a moderate-severity advisory** via `esbuild` in its dev
   dependency chain. It is a build-time tool not on any request path, and the
   `npm audit fix` remedy downgrades to drizzle-kit 0.18. Left as-is knowingly.
