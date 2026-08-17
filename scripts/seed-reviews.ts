/**
 * Generates review data the only way the schema allows: behind real completed
 * bookings.
 *
 * `reviews.booking_id` is NOT NULL and UNIQUE, and `submitReview` refuses
 * anything that isn't a `completed` booking belonging to the caller — so there is
 * no shortcut here and deliberately none added. Every row this writes has walked
 * the whole flow through the same services the routes call:
 *
 *   1. `signup()` / `verifyEmail()` — parent account, token read from the console
 *      driver's outbox (they are stored hashed, so that is the only way back)
 *   2. `createBooking()` — learner, consents, `pending_payment`, real Stripe
 *      test-mode Checkout Session
 *   3. `handleStripeEvent()` — synthetic-but-shaped `checkout.session.completed`
 *      then `payment_intent.succeeded`, so payment truth comes from the one
 *      implemented source of it
 *   4. `confirmBooking()` — a coordinator this script creates assigns the educator
 *   5. `recordBookingOutcome()` with `completed` — the session happened, which is
 *      the fact a review is a statement about
 *   6. `submitReview()` as the parent, then `moderateReview()` as the coordinator
 *
 * The Stripe object ids from step 3 on are synthetic (`pi_seed_*`), because a
 * Checkout Session can only be completed by a browser. Consequence, same as
 * `seed-bookings.ts`: a live refund against these will fail at Stripe.
 *
 *   npx tsx scripts/seed-reviews.ts
 *
 * Requires `npm run seed:pricing` first — it spreads reviews across all nine of
 * the educators that creates. Safe to re-run: every run uses fresh emails and
 * fresh bookings, so it adds another batch. Refuses to run against production.
 */

// The email driver must be decided before any src import evaluates env.ts.
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = process.env.RUN_ID ?? `sr${Date.now().toString(36)}`;
const OUTBOX = join(tmpdir(), `ylj-review-outbox-${RUN}.jsonl`);
mkdirSync(tmpdir(), { recursive: true });
process.env.EMAIL_DRIVER = "console";
process.env.EMAIL_OUTBOX_FILE = OUTBOX;

// Everything from src is imported dynamically so the overrides above win.
const { env } = await import("../src/env.ts");

if (env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
  console.error("seed-reviews generates fake data — refusing to run in production.");
  process.exit(1);
}

/*
 * As in `seed-bookings`: the environment check above cannot see that a
 * development machine is pointed at the production database, so the host has to
 * be named explicitly.
 */
const { assertSeedTarget } = await import("../src/lib/seed-guard.ts");
assertSeedTarget("seed-reviews");

const { eq, sql } = await import("drizzle-orm");
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
const { confirmBooking, recordBookingOutcome } = await import(
  "../src/services/booking-ops.service.ts"
);
const { moderateReview, submitReview } = await import(
  "../src/services/review.service.ts"
);
const { handleStripeEvent } = await import("../src/services/stripe-webhook.service.ts");
const { createBookingRequestSchema, moderateReviewSchema, signupRequestSchema, submitReviewSchema } =
  await Promise.all([
    import("../src/contracts/bookings.ts"),
    import("../src/contracts/auth.ts"),
    import("../src/contracts/reviews.ts"),
  ]).then(([bookings, auth, reviews]) => ({
    createBookingRequestSchema: bookings.createBookingRequestSchema,
    signupRequestSchema: auth.signupRequestSchema,
    moderateReviewSchema: reviews.moderateReviewSchema,
    submitReviewSchema: reviews.submitReviewSchema,
  }));

import type { AuthenticatedPrincipal } from "../src/services/session.service.ts";

const CTX = { ip: "198.51.100.77", userAgent: "seed-reviews", requestId: null };
const PASSWORD = "seed-data-passphrase-1";

/**
 * A civil date `days` from today in the platform's operating zone, which is what
 * `createBooking` validates against the minimum notice and the booking window.
 * Relative, never a literal: fixed dates stop being seedable a couple of months
 * after they are written.
 */
function civilDateIn(days: number): string {
  const today = civilToday();
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

interface Parent {
  principal: AuthenticatedPrincipal;
  fullName: string;
  email: string;
  phone: string;
}

/** Signup → verify → login, the order a real parent goes through. */
async function createParent(
  fullName: string,
  slug: string,
  phone: string,
  subjects: string[],
): Promise<Parent> {
  const email = `seed.${slug}.${RUN}@example.com`;

  await signup(
    signupRequestSchema.parse({
      fullName,
      email,
      password: PASSWORD,
      consentGiven: true,
      subjectsOfInterest: subjects,
    }),
    CTX,
  );

  await verifyEmail(await tokenFromOutbox("/verify-email", email), CTX);

  // A fresh login after verification, so the principal carries emailVerifiedAt —
  // `createBooking` refuses an unverified address.
  const session = await login({ email, password: PASSWORD, rememberMe: false }, CTX);
  const principal = await resolveSession(session.token);
  if (!principal) throw new Error(`could not resolve a session for ${email}`);

  console.log(`parent   ${fullName} <${email}>`);
  return { principal, fullName, email, phone };
}

/**
 * A coordinator to confirm the bookings and moderate the reviews. Staff are
 * invite-only with no public route, so this bootstraps one out-of-band the same
 * way `seed-admin.ts` does, then signs in through the normal login.
 */
async function createCoordinator(): Promise<AuthenticatedPrincipal> {
  const email = `seed.reviews.coordinator.${RUN}@example.com`;
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
// Payment — synthetic events through the implemented handler
// ---------------------------------------------------------------------------

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
async function markPaid(
  booking: { bookingId: string; reference: string; totalCents: number; currency: string },
  n: number,
): Promise<void> {
  const [payment] = await db
    .select({ sessionId: payments.stripeCheckoutSessionId })
    .from(payments)
    .where(eq(payments.bookingId, booking.bookingId))
    .limit(1);
  if (!payment?.sessionId) {
    throw new Error(`no payment row for booking ${booking.bookingId}`);
  }

  const piId = stripeId("pi", n);
  const metadata = projectMetadata({
    booking_id: booking.bookingId,
    booking_reference: booking.reference,
  });

  await fireEvent("checkout.session.completed", {
    object: "checkout.session",
    id: payment.sessionId,
    payment_intent: piId,
    payment_status: "paid",
    metadata,
  });

  await fireEvent("payment_intent.succeeded", {
    object: "payment_intent",
    id: piId,
    amount_received: booking.totalCents,
    currency: booking.currency.toLowerCase(),
    latest_charge: {
      id: stripeId("ch", n),
      balance_transaction: {
        id: stripeId("txn", n),
        fee: Math.round(booking.totalCents * 0.029) + 30,
      },
    },
    metadata,
  });
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

type AgeBand = "4-6" | "7-9" | "10-12" | "13-15" | "16-18";

interface Scenario {
  educatorSlug: string;
  parentKey: string;
  learner: { firstName: string; ageBand: AgeBand; focus?: string };
  format: "online" | "in_home";
  durationMinutes: 60 | 90 | 120;
  /** Days from today. See `civilDateIn`. */
  inDays: number;
  preferredTime: string;
  review: {
    overallRating: number;
    communicationRating?: number;
    knowledgeRating?: number;
    punctualityRating?: number;
    patienceRating?: number;
    body?: string;
  };
  /** `null` leaves the review in the queue, which is the point of two of them. */
  moderation: { action: "publish" | "reject"; note?: string } | null;
}

/*
 * Spread across all nine seeded educators, several with more than one published
 * review so no average is a single sample. Ratings are mostly 4s and 5s with one
 * 3, and nobody is left on an unbroken run of fives.
 *
 * Two reviews are left `pending` and one is rejected, so the moderation queue and
 * the rejection path are not empty on a fresh database. Facets are filled on most
 * rows, partially on a couple, and omitted entirely on two — that is what
 * exercises "averaged only over the rows that supplied it", which is invisible if
 * every row answers every question.
 */
const SCENARIOS: Scenario[] = [
  {
    educatorSlug: "elena",
    parentKey: "anjali",
    learner: { firstName: "Aarav", ageBand: "7-9", focus: "Multiplication and word problems." },
    format: "online",
    durationMinutes: 60,
    inDays: 8,
    preferredTime: "16:00",
    review: {
      overallRating: 5,
      communicationRating: 5,
      knowledgeRating: 5,
      punctualityRating: 5,
      patienceRating: 5,
      body: "He went from dreading his maths homework to getting it done before dinner. When he gets stuck she waits him out instead of handing him the answer, which is exactly what he needed.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "elena",
    parentKey: "sarah",
    learner: { firstName: "Freya", ageBand: "10-12", focus: "Fractions and decimals." },
    format: "online",
    durationMinutes: 60,
    inDays: 9,
    preferredTime: "17:00",
    review: {
      overallRating: 4,
      communicationRating: 3,
      knowledgeRating: 5,
      punctualityRating: 4,
      patienceRating: 5,
      body: "Good sessions and my daughter likes her. We did have to move the time twice in the first month, which was a scramble on our end.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "elena",
    parentKey: "david",
    learner: { firstName: "Noah", ageBand: "10-12" },
    format: "online",
    durationMinutes: 90,
    inDays: 10,
    preferredTime: "15:30",
    review: {
      overallRating: 5,
      communicationRating: 5,
      knowledgeRating: 5,
      punctualityRating: 4,
      patienceRating: 5,
      body: "She worked out that he had been guessing at fractions rather than understanding them, and went right back to basics without making him feel stupid about it.",
    },
    moderation: null,
  },
  {
    educatorSlug: "daniel",
    parentKey: "sarah",
    learner: { firstName: "Milo", ageBand: "7-9", focus: "Reading out loud." },
    format: "online",
    durationMinutes: 60,
    inDays: 7,
    preferredTime: "15:00",
    review: {
      overallRating: 4,
      communicationRating: 4,
      patienceRating: 5,
      body: "Solid help with reading. Our son reads to us in the evening now without being asked.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "daniel",
    parentKey: "nadia",
    learner: { firstName: "Ezra", ageBand: "7-9" },
    format: "online",
    durationMinutes: 60,
    inDays: 11,
    preferredTime: "16:30",
    review: {
      overallRating: 3,
      communicationRating: 3,
      knowledgeRating: 5,
      punctualityRating: 4,
      patienceRating: 3,
      body: "He knows the material, no question. The hour just felt flat for a seven year old and we were pulling teeth to get our son to sit through it. We may try someone with a bit more energy.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "priya",
    parentKey: "priya-r",
    learner: { firstName: "Dev", ageBand: "16-18", focus: "Personal essay for early applications." },
    format: "online",
    durationMinutes: 90,
    inDays: 12,
    preferredTime: "18:00",
    review: {
      overallRating: 5,
      communicationRating: 5,
      knowledgeRating: 5,
      punctualityRating: 5,
      patienceRating: 4,
      body: "He had three drafts and hated all of them. She asked him questions for twenty minutes and by the end he had something he actually wanted to send.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "priya",
    parentKey: "tom",
    learner: { firstName: "Grace", ageBand: "16-18" },
    format: "online",
    durationMinutes: 60,
    inDays: 13,
    preferredTime: "19:00",
    review: {
      overallRating: 4,
      communicationRating: 5,
      knowledgeRating: 4,
      punctualityRating: 5,
      patienceRating: 4,
      body: "Very organised. She sent a plan after the first call and stuck to it.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "marcus",
    parentKey: "anjali",
    learner: { firstName: "Isha", ageBand: "10-12", focus: "School recital in the spring." },
    format: "in_home",
    durationMinutes: 60,
    inDays: 14,
    preferredTime: "10:00",
    review: {
      overallRating: 4,
      communicationRating: 4,
      knowledgeRating: 5,
      punctualityRating: 3,
      patienceRating: 5,
      body: "She looks forward to piano now, which is not a sentence I expected to write. He ran ten minutes late twice.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "marcus",
    parentKey: "david",
    learner: { firstName: "Lily", ageBand: "13-15" },
    format: "in_home",
    durationMinutes: 90,
    inDays: 15,
    preferredTime: "11:00",
    review: {
      overallRating: 5,
      communicationRating: 5,
      knowledgeRating: 5,
      punctualityRating: 5,
      patienceRating: 5,
      body: "He built the lessons around what she wanted to play instead of a month of scales first. She practises on her own now.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "rosa",
    parentKey: "nadia",
    learner: { firstName: "Ezra", ageBand: "7-9" },
    format: "in_home",
    durationMinutes: 120,
    inDays: 16,
    preferredTime: "10:30",
    // No facets at all. A score and a sentence is a complete review, and this is
    // the row that proves the breakdown is averaged over answers, not over rows.
    review: {
      overallRating: 4,
      body: "Lovely with the kids. The kitchen was cleaner when she left than when she arrived.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "james",
    parentKey: "david",
    learner: { firstName: "Lily", ageBand: "13-15", focus: "Wants to cook one family dinner a week." },
    format: "in_home",
    durationMinutes: 120,
    inDays: 17,
    preferredTime: "11:00",
    review: {
      overallRating: 4,
      communicationRating: 4,
      knowledgeRating: 5,
      punctualityRating: 4,
      patienceRating: 4,
      body: "She can make three dinners unsupervised now. The knife safety part was thorough, which I appreciated more than she did.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "james",
    parentKey: "tom",
    learner: { firstName: "Grace", ageBand: "16-18" },
    format: "in_home",
    durationMinutes: 90,
    inDays: 18,
    preferredTime: "14:00",
    review: {
      overallRating: 5,
      communicationRating: 5,
      knowledgeRating: 5,
      punctualityRating: 4,
      patienceRating: 5,
      body: "Best money we have spent this year. He treats her like an adult in the kitchen and she has risen to it.",
    },
    moderation: null,
  },
  {
    educatorSlug: "lena",
    parentKey: "sarah",
    learner: { firstName: "Milo", ageBand: "7-9", focus: "Spanish, keeping it playful." },
    format: "online",
    durationMinutes: 60,
    inDays: 8,
    preferredTime: "09:30",
    review: {
      overallRating: 5,
      communicationRating: 5,
      knowledgeRating: 5,
      punctualityRating: 5,
      patienceRating: 5,
      body: "Spanish went from a chore to the thing he talks about at dinner. She turns it into games and he does not notice he is working.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "lena",
    parentKey: "priya-r",
    learner: { firstName: "Anya", ageBand: "13-15" },
    format: "online",
    durationMinutes: 60,
    inDays: 19,
    preferredTime: "17:30",
    // Facets omitted again, on an educator who has them elsewhere: her breakdown
    // is then averaged over one row while her overall score covers two.
    review: {
      overallRating: 4,
      body: "Really good. Getting a slot that worked for both of us took some back and forth.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "sofia",
    parentKey: "anjali",
    learner: { firstName: "Aarav", ageBand: "7-9", focus: "Hindi reading." },
    format: "online",
    durationMinutes: 60,
    inDays: 20,
    preferredTime: "16:00",
    review: {
      overallRating: 4,
      knowledgeRating: 5,
      punctualityRating: 4,
      body: "Hindi lessons with my mother in law listening in from the next room, which is a tough audience. She handled it.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "theo",
    parentKey: "david",
    learner: { firstName: "Noah", ageBand: "10-12", focus: "Loves drawing, wants to try painting." },
    format: "in_home",
    durationMinutes: 90,
    inDays: 13,
    preferredTime: "14:00",
    review: {
      overallRating: 4,
      communicationRating: 4,
      knowledgeRating: 4,
      punctualityRating: 5,
      patienceRating: 5,
      body: "He has filled a sketchbook since we started. Theo brings his own materials, which saved us a trip we would have got wrong anyway.",
    },
    moderation: { action: "publish" },
  },
  {
    educatorSlug: "theo",
    parentKey: "tom",
    learner: { firstName: "Grace", ageBand: "16-18" },
    format: "in_home",
    durationMinutes: 60,
    inDays: 20,
    preferredTime: "13:00",
    // Rejected for a real reason rather than an arbitrary one: a parent putting
    // their own phone number in a review is the ordinary case for this path.
    review: {
      overallRating: 5,
      communicationRating: 5,
      knowledgeRating: 5,
      punctualityRating: 5,
      patienceRating: 5,
      body: "Fantastic, cannot recommend enough. Any parent thinking about it can call me on 919 555 0198 and I will talk them through it.",
    },
    moderation: {
      action: "reject",
      note: "Contains the reviewer's phone number. Emailed her to ask for a version without it.",
    },
  },
];

const ADDRESS = {
  line1: "88 Willowbrook Rd",
  city: "Durham",
  state: "NC",
  postalCode: "27707",
  notes: "Gate code is on the booking; park on the street.",
};

// ---------------------------------------------------------------------------
// Run
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
const educators = new Map(
  (((educatorRows as { rows?: unknown[] }).rows ?? educatorRows) as Array<{
    slug: string;
    name: string;
    topics: string[];
    subject_slug: string;
  }>).map((row) => [row.slug, row]),
);

const missing = [...new Set(SCENARIOS.map((s) => s.educatorSlug))].filter(
  (slug) => !educators.has(slug),
);
if (missing.length > 0) {
  console.error(
    `Missing approved educators with a rate: ${missing.join(", ")}. Run \`npm run seed:pricing\` first.`,
  );
  await closeDatabase();
  process.exit(1);
}

const coordinator = await createCoordinator();

const parents = new Map<string, Parent>([
  ["anjali", await createParent("Anjali Mehra", "anjali", "+1 919 555 0141", ["tutoring", "music"])],
  ["sarah", await createParent("Sarah Whitfield", "sarah", "+1 984 555 0102", ["languages"])],
  ["david", await createParent("David Chen", "david", "+1 919 555 0177", ["arts-crafts", "cooking"])],
  ["priya-r", await createParent("Priya Raman", "priya", "+1 704 555 0163", ["college-admissions"])],
  ["nadia", await createParent("Nadia Osei", "nadia", "+1 919 555 0188", ["tutoring", "cooking"])],
  ["tom", await createParent("Tom Bradley", "tom", "+1 336 555 0119", ["cooking", "arts-crafts"])],
]);

interface Result {
  reference: string;
  educatorSlug: string;
  educatorName: string;
  reviewerInitial: string;
  overallRating: number;
  status: "pending" | "published" | "rejected";
}

const results: Result[] = [];

for (const [i, scenario] of SCENARIOS.entries()) {
  const educator = educators.get(scenario.educatorSlug)!;
  const parent = parents.get(scenario.parentKey)!;

  // Validated through the same contract the route applies, then the same service.
  const input = createBookingRequestSchema.parse({
    educatorSlug: educator.slug,
    subjectSlug: educator.subject_slug,
    subjectTopic: educator.topics[0] ?? "General session",
    format: scenario.format,
    durationMinutes: scenario.durationMinutes,
    preferredDate: civilDateIn(scenario.inDays),
    preferredTime: scenario.preferredTime,
    flexibleTime: false,
    learner: scenario.learner,
    contact: { fullName: parent.fullName, email: parent.email, phone: parent.phone },
    address: scenario.format === "in_home" ? ADDRESS : undefined,
    learnerDataConsentGiven: true,
    guardianConfirmed: true,
  });

  const created = await createBooking(input, parent.principal, CTX);

  await markPaid(
    {
      bookingId: created.bookingId,
      reference: created.reference,
      totalCents: created.quote.totalCents,
      currency: created.quote.currency,
    },
    i,
  );

  await confirmBooking(
    created.bookingId,
    { educatorSlug: educator.slug, note: "Time confirmed with the parent by phone." },
    coordinator,
    CTX,
  );

  // The step everything else here exists to reach: without a `completed`
  // booking, `submitReview` refuses and there is no other way in.
  await recordBookingOutcome(
    created.bookingId,
    { outcome: "completed", note: "Session went ahead as planned." },
    coordinator,
    CTX,
  );

  const submitted = await submitReview(
    created.bookingId,
    submitReviewSchema.parse(scenario.review),
    parent.principal,
    CTX,
  );

  let status: Result["status"] = "pending";
  if (scenario.moderation) {
    const decision = await moderateReview(
      submitted.reviewId,
      moderateReviewSchema.parse(scenario.moderation),
      coordinator,
      CTX,
    );
    status = decision.status;
  }

  results.push({
    reference: created.reference,
    educatorSlug: educator.slug,
    educatorName: educator.name,
    reviewerInitial: parent.fullName.charAt(0).toUpperCase(),
    overallRating: scenario.review.overallRating,
    status,
  });

  console.log(
    `review   ${created.reference}  ${educator.name.padEnd(12)} ${scenario.review.overallRating}★  ${status.padEnd(9)} ${parent.fullName}`,
  );
}

// ---------------------------------------------------------------------------
// Summary — read back from the database, not from what was attempted
// ---------------------------------------------------------------------------

const byStatus = results.reduce<Record<string, number>>((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});

console.log(
  `\nCreated ${results.length} completed bookings and ${results.length} reviews ` +
    `(${byStatus.published ?? 0} published, ${byStatus.pending ?? 0} pending, ${byStatus.rejected ?? 0} rejected).`,
);

const cached = await db.execute(sql`
  select
    ep.slug,
    ep.name,
    ep.rating_cached,
    ep.review_count_cached,
    (select count(*) from reviews r
      where r.educator_profile_id = ep.id and r.status = 'published')::int as published_rows
  from educator_profiles ep
  where ep.slug in (${sql.join(
    [...new Set(SCENARIOS.map((s) => s.educatorSlug))].map((slug) => sql`${slug}`),
    sql`, `,
  )})
  order by ep.slug
`);

console.log("\nCached aggregates (educator_profiles, written by moderateReview):");
for (const row of ((cached as { rows?: unknown[] }).rows ?? cached) as Array<{
  slug: string;
  name: string;
  rating_cached: number | null;
  review_count_cached: number;
  published_rows: number;
}>) {
  // `rating_cached` is the average in tenths, so 45 reads back as 4.5.
  const average = row.rating_cached === null ? "—" : (row.rating_cached / 10).toFixed(1);
  console.log(
    `  ${row.slug.padEnd(8)} ${row.name.padEnd(12)} ${average.padStart(4)}  ` +
      `count ${String(row.review_count_cached).padStart(2)}  (published rows: ${row.published_rows})`,
  );
}

console.log(`\nParents can sign in with password: ${PASSWORD}`);
console.log(`Coordinator: seed.reviews.coordinator.${RUN}@example.com / ${PASSWORD}`);

await closeDatabase();
