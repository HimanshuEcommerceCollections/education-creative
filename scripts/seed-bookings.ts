/**
 * Generates test booking data by walking the implemented flow in its real order,
 * calling the same services the routes call — never writing a status directly:
 *
 *   1. `signup()` — parent account, consent record, verification email
 *   2. `verifyEmail()` — token read from the console driver's outbox, exactly
 *      as the e2e suite does (tokens are stored hashed, so the outbox is the
 *      only way to read one back)
 *   3. `createBooking()` — learner + consents + `pending_payment` booking + a
 *      real Stripe test-mode Checkout Session
 *   4. `handleStripeEvent()` — synthetic-but-shaped `checkout.session.completed`
 *      then `payment_intent.succeeded`, so the paid transition, ledger entries
 *      and audit rows all come from the one implemented source of payment truth
 *   5. `confirmBooking()` / `charge.refunded` — coordinator confirmation and
 *      the refund states, again through the implemented transitions
 *
 * The Stripe *object ids* in step 4+ are synthetic (`pi_seed_*`), because a
 * Checkout Session can only be completed by a browser. Everything else is real.
 * Consequence: a live refund against these bookings will fail at Stripe — this
 * is display/queue test data, not data to run money operations on.
 *
 *   npx tsx scripts/seed-bookings.ts
 *
 * Safe to re-run: every run uses fresh emails, so it adds another batch rather
 * than colliding with the last one. Refuses to run against production.
 */

// The email driver must be decided before any src import evaluates env.ts.
// Console + outbox is the implemented dev path for reading one-time tokens;
// it also guarantees no real mail is attempted for the fake addresses below.
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = process.env.RUN_ID ?? `sb${Date.now().toString(36)}`;
const OUTBOX = join(tmpdir(), `ylj-seed-outbox-${RUN}.jsonl`);
mkdirSync(tmpdir(), { recursive: true });
process.env.EMAIL_DRIVER = "console";
process.env.EMAIL_OUTBOX_FILE = OUTBOX;

// Everything from src is imported dynamically so the overrides above win.
const { env } = await import("../src/env.ts");

if (env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
  console.error("seed-bookings generates fake data — refusing to run in production.");
  process.exit(1);
}

const { and, eq, isNull, sql } = await import("drizzle-orm");
const { closeDatabase, db } = await import("../src/db/client.ts");
const { authIdentities, payments, userRoles, users } = await import(
  "../src/db/schema/index.ts"
);
const { civilToday } = await import("../src/lib/civil-time.ts");
const { hashPassword } = await import("../src/lib/password.ts");
const { projectMetadata } = await import("../src/lib/stripe.ts");
const { login, signup, verifyEmail } = await import("../src/services/auth.service.ts");
const { resolveSession } = await import("../src/services/session.service.ts");
const { createBooking } = await import("../src/services/booking.service.ts");
const { confirmBooking } = await import("../src/services/booking-ops.service.ts");
const { handleStripeEvent } = await import(
  "../src/services/stripe-webhook.service.ts"
);
const { createBookingRequestSchema, signupRequestSchema } = await Promise.all([
  import("../src/contracts/bookings.ts"),
  import("../src/contracts/auth.ts"),
]).then(([bookings, auth]) => ({
  createBookingRequestSchema: bookings.createBookingRequestSchema,
  signupRequestSchema: auth.signupRequestSchema,
}));

import type { AuthenticatedPrincipal } from "../src/services/session.service.ts";

const CTX = { ip: "198.51.100.42", userAgent: "seed-bookings", requestId: null };
const PASSWORD = "seed-data-passphrase-1";

/**
 * A civil date `days` from today in the platform's operating zone, which is what
 * `createBooking` validates against the minimum notice and the booking window.
 */
function civilDateIn(days: number): string {
  const today = civilToday();
  // UTC arithmetic on the civil parts, so the day count can't be bent by an
  // offset change between here and the target date.
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
  return shifted.toISOString().slice(0, 10);
}

let eventCounter = 0;
const eventId = () => `evt_seed_${RUN}_${++eventCounter}`;
const stripeId = (prefix: string, n: number) => `${prefix}_seed_${RUN}_${n}`;

// ---------------------------------------------------------------------------
// Outbox — how single-use tokens are read back (they're stored hashed)
// ---------------------------------------------------------------------------

async function tokenFromOutbox(pathPrefix: string, recipient: string): Promise<string> {
  const raw = await readFile(OUTBOX, "utf8");
  const lines = raw.split("\n").filter(Boolean).reverse();

  for (const line of lines) {
    let entry: { to?: string; links?: string[] };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.to !== recipient) continue;
    const link = entry.links?.find((l) => l.includes(`${pathPrefix}?token=`));
    if (link) return new URL(link).searchParams.get("token")!;
  }
  throw new Error(`No ${pathPrefix} token found in the outbox for ${recipient}`);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Signup → verify → login, the order a real parent goes through. */
async function createParent(
  fullName: string,
  slug: string,
  subjects: string[],
): Promise<{ principal: AuthenticatedPrincipal; email: string }> {
  const email = `seed.${slug}.${RUN}@example.com`;

  const input = signupRequestSchema.parse({
    fullName,
    email,
    password: PASSWORD,
    consentGiven: true,
    subjectsOfInterest: subjects,
  });
  await signup(input, CTX);

  const token = await tokenFromOutbox("/verify-email", email);
  await verifyEmail(token, CTX);

  // A fresh login after verification, so the principal carries emailVerifiedAt.
  const session = await login({ email, password: PASSWORD, rememberMe: false }, CTX);
  const principal = await resolveSession(session.token);
  if (!principal) throw new Error(`could not resolve a session for ${email}`);

  console.log(`parent   ${fullName} <${email}>`);
  return { principal, email };
}

/**
 * A coordinator to work the queue. Staff are invite-only with no public route,
 * so this bootstraps one the same way `seed-admin.ts` bootstraps the first
 * admin — out-of-band, then signs in through the normal login.
 */
async function createCoordinator(): Promise<AuthenticatedPrincipal> {
  const email = `seed.coordinator.${RUN}@example.com`;
  const passwordHash = await hashPassword(PASSWORD);

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      fullName: "Seed Coordinator",
      status: "active",
      emailVerifiedAt: new Date(),
      ageGateAttestedAt: new Date(),
    })
    .returning({ id: users.id });

  await db.insert(userRoles).values({ userId: user!.id, role: "coordinator" });
  await db.insert(authIdentities).values({
    userId: user!.id,
    provider: "password",
    providerAccountId: user!.id,
  });

  const session = await login({ email, password: PASSWORD, rememberMe: false }, CTX);
  const principal = await resolveSession(session.token);
  if (!principal) throw new Error("could not resolve the coordinator session");

  console.log(`staff    Seed Coordinator <${email}>`);
  return principal;
}

// ---------------------------------------------------------------------------
// Payment transitions — synthetic events through the implemented handler
// ---------------------------------------------------------------------------

interface SeededBooking {
  bookingId: string;
  reference: string;
  totalCents: number;
  currency: string;
}

async function paymentRowFor(bookingId: string) {
  const [row] = await db
    .select({ sessionId: payments.stripeCheckoutSessionId })
    .from(payments)
    .where(eq(payments.bookingId, bookingId))
    .limit(1);
  if (!row?.sessionId) throw new Error(`no payment row for booking ${bookingId}`);
  return row;
}

/** Fires an event exactly as the webhook route would after signature checks. */
async function fireEvent(type: string, object: Record<string, unknown>): Promise<void> {
  await handleStripeEvent({
    id: eventId(),
    object: "event",
    type,
    data: { object },
    // Only id/type/data are read by the handler; the rest satisfies the type.
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
  } as never);
}

/** checkout.session.completed → payment_intent.succeeded, in webhook order. */
async function markPaid(b: SeededBooking, n: number): Promise<{ chargeId: string; piId: string }> {
  const { sessionId } = await paymentRowFor(b.bookingId);
  const piId = stripeId("pi", n);
  const chargeId = stripeId("ch", n);
  const metadata = projectMetadata({
    booking_id: b.bookingId,
    booking_reference: b.reference,
  });

  await fireEvent("checkout.session.completed", {
    object: "checkout.session",
    id: sessionId,
    payment_intent: piId,
    payment_status: "paid",
    metadata,
  });

  await fireEvent("payment_intent.succeeded", {
    object: "payment_intent",
    id: piId,
    amount_received: b.totalCents,
    currency: b.currency.toLowerCase(),
    latest_charge: {
      id: chargeId,
      // A plausible card fee, so ledger and payout views have a real-looking number.
      balance_transaction: {
        id: stripeId("txn", n),
        fee: Math.round(b.totalCents * 0.029) + 30,
      },
    },
    metadata,
  });

  return { chargeId, piId };
}

async function markRefunded(
  b: SeededBooking,
  ids: { chargeId: string; piId: string },
  refundedCents: number,
): Promise<void> {
  await fireEvent("charge.refunded", {
    object: "charge",
    id: ids.chargeId,
    payment_intent: ids.piId,
    amount: b.totalCents,
    amount_refunded: refundedCents,
    currency: b.currency.toLowerCase(),
    metadata: projectMetadata({
      booking_id: b.bookingId,
      booking_reference: b.reference,
    }),
  });
}

async function markExpired(b: SeededBooking): Promise<void> {
  const { sessionId } = await paymentRowFor(b.bookingId);
  await fireEvent("checkout.session.expired", {
    object: "checkout.session",
    id: sessionId,
    payment_intent: null,
    metadata: projectMetadata({
      booking_id: b.bookingId,
      booking_reference: b.reference,
    }),
  });
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

/** Approved educators with a rated subject — the only ones a confirm may name. */
const educatorRows = await db.execute(sql`
  select ep.slug, ep.name, ep.subjects as topics, s.slug as subject_slug
  from educator_profiles ep
  join educator_rates er on er.educator_profile_id = ep.id
  join subjects s on s.id = er.subject_id and s.is_active = true
  where ep.verification_status = 'approved' and ep.deleted_at is null
  order by ep.slug
`);
const educators = ((educatorRows as { rows?: unknown[] }).rows ?? educatorRows) as Array<{
  slug: string;
  name: string;
  topics: string[];
  subject_slug: string;
}>;

if (educators.length < 2) {
  console.error("Need at least two approved educators — run `npm run seed:pricing` first.");
  await closeDatabase();
  process.exit(1);
}

const educator = (i: number) => educators[i % educators.length]!;
const topicOf = (e: { topics: string[] }) => e.topics[0] ?? "General session";

const coordinator = await createCoordinator();
const anjali = await createParent("Anjali Mehra", "anjali", ["tutoring", "music"]);
const sarah = await createParent("Sarah Whitfield", "sarah", ["languages"]);
const david = await createParent("David Chen", "david", ["cooking", "arts-crafts"]);
const priya = await createParent("Priya Raman", "priya", ["college-admissions"]);

const ADDRESS = {
  line1: "412 Maple Grove Ln",
  city: "Raleigh",
  state: "NC",
  postalCode: "27607",
  notes: "Blue door on the side; parking in the driveway is fine.",
};

interface Scenario {
  parent: { principal: AuthenticatedPrincipal; email: string };
  parentName: string;
  phone: string;
  learner: { firstName: string; ageBand: "4-6" | "7-9" | "10-12" | "13-15" | "16-18"; focus?: string };
  educatorIndex: number;
  format: "online" | "in_home";
  durationMinutes: 60 | 90 | 120;
  /**
   * Days from today, not a literal date: `createBooking` enforces the minimum
   * notice and the booking window, so fixed dates would quietly stop being
   * seedable a couple of months after they were written.
   */
  inDays: number;
  preferredTime: string;
  alternateTime?: string;
  flexibleTime?: boolean;
  /** Where in the implemented lifecycle this booking stops. */
  target:
    | "pending_payment"
    | "expired"
    | "paid_unconfirmed"
    | "confirmed"
    | "confirmed_substituted"
    | "refunded"
    | "partially_refunded";
}

const SCENARIOS: Scenario[] = [
  // The coordinator queue — what the dashboard revolves around.
  { parent: anjali, parentName: "Anjali Mehra", phone: "+1 919 555 0141", learner: { firstName: "Aarav", ageBand: "7-9", focus: "Multiplication tables and word problems." }, educatorIndex: 0, format: "online", durationMinutes: 60, inDays: 8, preferredTime: "16:00", alternateTime: "17:00", target: "paid_unconfirmed" },
  { parent: anjali, parentName: "Anjali Mehra", phone: "+1 919 555 0141", learner: { firstName: "Isha", ageBand: "10-12", focus: "Preparing for a school recital." }, educatorIndex: 1, format: "in_home", durationMinutes: 90, inDays: 9, preferredTime: "10:00", flexibleTime: true, target: "paid_unconfirmed" },
  { parent: sarah, parentName: "Sarah Whitfield", phone: "+1 984 555 0102", learner: { firstName: "Milo", ageBand: "4-6" }, educatorIndex: 2, format: "online", durationMinutes: 60, inDays: 11, preferredTime: "15:30", target: "paid_unconfirmed" },
  { parent: david, parentName: "David Chen", phone: "+1 919 555 0177", learner: { firstName: "Lily", ageBand: "13-15", focus: "Wants to cook dinner for the family once a week." }, educatorIndex: 3, format: "in_home", durationMinutes: 120, inDays: 15, preferredTime: "11:00", target: "paid_unconfirmed" },

  // Confirmed — one as requested, one where the coordinator substituted.
  { parent: sarah, parentName: "Sarah Whitfield", phone: "+1 984 555 0102", learner: { firstName: "Milo", ageBand: "4-6", focus: "Spanish basics, keeping it playful." }, educatorIndex: 4, format: "online", durationMinutes: 60, inDays: 7, preferredTime: "09:30", target: "confirmed" },
  { parent: priya, parentName: "Priya Raman", phone: "+1 704 555 0163", learner: { firstName: "Dev", ageBand: "16-18", focus: "Personal essay draft is due mid-September." }, educatorIndex: 5, format: "online", durationMinutes: 90, inDays: 10, preferredTime: "18:00", alternateTime: "19:00", target: "confirmed" },
  { parent: david, parentName: "David Chen", phone: "+1 919 555 0177", learner: { firstName: "Noah", ageBand: "10-12", focus: "Loves drawing, wants to try painting." }, educatorIndex: 6, format: "in_home", durationMinutes: 90, inDays: 13, preferredTime: "14:00", target: "confirmed_substituted" },

  // The money paths.
  { parent: priya, parentName: "Priya Raman", phone: "+1 704 555 0163", learner: { firstName: "Dev", ageBand: "16-18" }, educatorIndex: 7, format: "online", durationMinutes: 60, inDays: 6, preferredTime: "17:30", target: "refunded" },
  { parent: anjali, parentName: "Anjali Mehra", phone: "+1 919 555 0141", learner: { firstName: "Aarav", ageBand: "7-9" }, educatorIndex: 8, format: "in_home", durationMinutes: 120, inDays: 12, preferredTime: "10:00", target: "partially_refunded" },

  // The states before money: an open checkout, and one that timed out.
  { parent: sarah, parentName: "Sarah Whitfield", phone: "+1 984 555 0102", learner: { firstName: "Milo", ageBand: "4-6" }, educatorIndex: 0, format: "online", durationMinutes: 60, inDays: 18, preferredTime: "16:00", target: "pending_payment" },
  { parent: david, parentName: "David Chen", phone: "+1 919 555 0177", learner: { firstName: "Lily", ageBand: "13-15" }, educatorIndex: 1, format: "online", durationMinutes: 60, inDays: 19, preferredTime: "13:00", target: "expired" },
];

const results: Array<{ reference: string; target: string; parent: string; educator: string }> = [];

for (const [i, s] of SCENARIOS.entries()) {
  const requested = educator(s.educatorIndex);

  // Validated through the same contract the route applies, then the same service.
  const input = createBookingRequestSchema.parse({
    educatorSlug: requested.slug,
    subjectSlug: requested.subject_slug,
    subjectTopic: topicOf(requested),
    format: s.format,
    durationMinutes: s.durationMinutes,
    preferredDate: civilDateIn(s.inDays),
    preferredTime: s.preferredTime,
    alternateTime: s.alternateTime,
    flexibleTime: s.flexibleTime ?? false,
    learner: s.learner,
    contact: { fullName: s.parentName, email: s.parent.email, phone: s.phone },
    address: s.format === "in_home" ? ADDRESS : undefined,
    learnerDataConsentGiven: true,
    guardianConfirmed: true,
  });

  const created = await createBooking(input, s.parent.principal, CTX);
  const booking: SeededBooking = {
    bookingId: created.bookingId,
    reference: created.reference,
    totalCents: created.quote.totalCents,
    currency: created.quote.currency,
  };

  let confirmedWith = "";

  if (s.target === "expired") {
    await markExpired(booking);
  } else if (s.target !== "pending_payment") {
    const ids = await markPaid(booking, i);

    if (s.target === "confirmed" || s.target === "confirmed_substituted") {
      const assigned =
        s.target === "confirmed_substituted"
          ? educator(s.educatorIndex + 1)
          : requested;
      await confirmBooking(
        booking.bookingId,
        {
          educatorSlug: assigned.slug,
          note:
            s.target === "confirmed_substituted"
              ? `${requested.name} is unavailable that week — parent agreed to ${assigned.name} on the phone.`
              : "Time confirmed with the parent by phone.",
        },
        coordinator,
        CTX,
      );
      confirmedWith = assigned.name;
    } else if (s.target === "refunded") {
      await markRefunded(booking, ids, booking.totalCents);
    } else if (s.target === "partially_refunded") {
      // Half back — the "session cut short" conflict resolution.
      await markRefunded(booking, ids, Math.round(booking.totalCents / 2));
    }
  }

  results.push({
    reference: booking.reference,
    target: s.target + (confirmedWith ? ` → ${confirmedWith}` : ""),
    parent: s.parentName,
    educator: requested.name,
  });
  console.log(
    `booking  ${booking.reference}  ${s.target.padEnd(22)} ${s.parentName} · ${requested.name} · $${(booking.totalCents / 100).toFixed(2)}`,
  );
}

// Final statuses straight from the database, so the summary reports what
// actually happened rather than what was attempted.
const statuses = await db.execute(sql`
  select reference, status from bookings
  where reference in (${sql.join(results.map((r) => sql`${r.reference}`), sql`, `)})
  order by created_at
`);

console.log("\nSeeded bookings (status from the database):");
for (const row of ((statuses as { rows?: unknown[] }).rows ?? statuses) as Array<{
  reference: string;
  status: string;
}>) {
  const r = results.find((x) => x.reference === row.reference);
  console.log(`  ${row.reference}  ${row.status.padEnd(20)} ${r?.parent} — ${r?.educator}`);
}

console.log(`\nParents can sign in with password: ${PASSWORD}`);
console.log(`Coordinator: seed.coordinator.${RUN}@example.com / ${PASSWORD}`);

await closeDatabase();
