import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidv7 } from "../../lib/id.ts";
import { users } from "./auth.ts";
import { educatorProfiles } from "./educators.ts";
import { subjects } from "./pricing.ts";
import {
  bookingFormatEnum,
  bookingStatusEnum,
  learnerAgeBandEnum,
  ledgerAccountEnum,
  ledgerStatusEnum,
  paymentStatusEnum,
} from "./enums.ts";
import { customerProfiles } from "./profiles.ts";

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * A child a parent books for.
 *
 * **No `users` row, ever.** A learner has no login, no password and no email —
 * that absence is the COPPA basis, not an omission to be filled in later. The
 * parent is the account holder and the only person who can reach this row.
 *
 * `firstNameEncrypted` holds AES-256-GCM ciphertext (`lib/crypto-field.ts`), and
 * only a first name goes in it. A surname would add identifiability without
 * adding a single thing an educator needs to teach a lesson.
 */
export const learners = pgTable(
  "learners",
  {
    id: id(),
    customerProfileId: uuid()
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "cascade" }),
    firstNameEncrypted: text().notNull(),
    ageBand: learnerAgeBandEnum().notNull(),
    /** Encrypted too: "struggles with word problems" is about a named child. */
    focusEncrypted: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * Crypto-shredding target. A parent's delete nulls the ciphertext columns and
     * stamps this, rather than dropping a row that bookings and audit rows
     * reference.
     */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index("learners_customer_idx").on(table.customerProfileId)],
);

/**
 * An immutable price the server computed and will honour for a few minutes.
 *
 * Booking creation re-validates one of these and derives the PaymentIntent amount
 * from it. No endpoint anywhere accepts an amount from a client, which is why
 * this table exists at all rather than the total simply being recomputed at
 * charge time: it pins *what was quoted* so "why was I charged this?" has an
 * answer that doesn't require replaying a rate history.
 */
export const quotes = pgTable(
  "quotes",
  {
    id: id(),
    customerProfileId: uuid()
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "cascade" }),
    educatorProfileId: uuid()
      .notNull()
      .references(() => educatorProfiles.id, { onDelete: "restrict" }),
    /** The priced category, which is what the rate and band hang off. */
    subjectId: uuid()
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict" }),
    /** The topic the parent chose, e.g. "Piano". Not priced; shown to staff. */
    subjectTopic: text().notNull(),
    format: bookingFormatEnum().notNull(),
    durationMinutes: integer().notNull(),

    currency: text().notNull(),
    /** `[{ label, amountCents }]`, the receipt breakdown. */
    lineItems: jsonb().notNull(),
    totalCents: integer().notNull(),

    /** The rate actually used, after band clamping. */
    effectiveRatePerHourCents: integer().notNull(),
    takeRateBps: integer().notNull(),
    educatorEarningsCents: integer().notNull(),
    platformMarginCents: integer().notNull(),
    expectedFeeCents: integer().notNull(),

    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Set when a booking consumes it, so one quote can't fund two bookings. */
    consumedAt: timestamp({ withTimezone: true }),
    consumedByBookingId: uuid(),
    createdAt: createdAt(),
  },
  (table) => [
    index("quotes_customer_idx").on(table.customerProfileId),
    index("quotes_expires_idx").on(table.expiresAt),
  ],
);

/**
 * The booking.
 *
 * `educatorProfileId` is the educator the parent **requested**; `assignedEducatorId`
 * is who a coordinator actually dispatched. Keeping them apart is what lets the
 * request survive a substitution, and what stops the confirmation step from
 * silently rewriting what the parent asked for.
 *
 * `frozenQuote` is a JSON snapshot rather than a foreign key to a version graph:
 * replaying "what was this parent charged, and why" should need one row, not a
 * join across effective-dated pricing tables.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    /** Human-quotable, e.g. "YLJ-7F3K2Q". Shown on the confirmation screen. */
    reference: text().notNull(),

    customerProfileId: uuid()
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    learnerId: uuid()
      .notNull()
      .references(() => learners.id, { onDelete: "restrict" }),
    /** Who the parent asked for. Never overwritten by an assignment. */
    educatorProfileId: uuid()
      .notNull()
      .references(() => educatorProfiles.id, { onDelete: "restrict" }),
    /** Who a coordinator dispatched. Null until confirmed. */
    assignedEducatorId: uuid().references(() => educatorProfiles.id, {
      onDelete: "set null",
    }),

    subjectId: uuid()
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict" }),
    subjectTopic: text().notNull(),
    format: bookingFormatEnum().notNull(),
    durationMinutes: integer().notNull(),

    /**
     * The requested slot, as a civil date and time in the platform's operating
     * timezone — not an instant. A parent asking for "Saturday 9am" means that on
     * their wall clock, and storing a UTC timestamp would make a DST change move
     * the lesson.
     */
    preferredDate: text().notNull(),
    preferredTime: text().notNull(),
    alternateTime: text(),
    flexibleTime: boolean().notNull().default(false),

    /** Encrypted address JSON, present only for `in_home`. */
    addressEncrypted: text(),

    status: bookingStatusEnum().notNull().default("pending_payment"),

    currency: text().notNull(),
    frozenQuote: jsonb().notNull(),
    totalCents: integer().notNull(),
    takeRateBpsSnapshot: integer().notNull(),
    educatorEarningsCents: integer().notNull(),
    platformMarginCents: integer().notNull(),

    /**
     * When the auto-refund fires if no coordinator has confirmed. A column rather
     * than a computed deadline so the sweeper is one indexed query.
     */
    slaDeadline: timestamp({ withTimezone: true }).notNull(),

    coordinatorId: uuid().references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("bookings_reference_key").on(table.reference),
    index("bookings_customer_idx").on(table.customerProfileId),
    index("bookings_status_idx").on(table.status),
    index("bookings_educator_idx").on(table.educatorProfileId),
    index("bookings_assigned_idx").on(table.assignedEducatorId),
    /**
     * Drives the SLA sweeper: only bookings still waiting on a coordinator can
     * auto-refund, so the index carries just those.
     */
    index("bookings_sla_idx")
      .on(table.slaDeadline)
      .where(sql`status = 'paid_unconfirmed'`),
  ],
);

/**
 * One Stripe payment attempt.
 *
 * The partial unique index is the double-charge guard: at most one *live*
 * PaymentIntent per booking. A second checkout attempt reuses the existing
 * client secret rather than minting a new intent, so a parent who reloads the
 * payment step cannot end up with two authorisations.
 */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    bookingId: uuid()
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),

    stripeCheckoutSessionId: text(),
    stripePaymentIntentId: text(),
    stripeChargeId: text(),
    stripeBalanceTransactionId: text(),

    status: paymentStatusEnum().notNull().default("requires_payment"),
    currency: text().notNull(),
    amountCents: integer().notNull(),
    amountReceivedCents: integer().notNull().default(0),
    amountRefundedCents: integer().notNull().default(0),
    /** The real fee, from the balance transaction. Null until settled. */
    stripeFeeCents: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("payments_intent_key").on(table.stripePaymentIntentId),
    uniqueIndex("payments_checkout_session_key").on(table.stripeCheckoutSessionId),
    index("payments_booking_idx").on(table.bookingId),
    uniqueIndex("payments_one_live_per_booking")
      .on(table.bookingId)
      .where(sql`status in ('requires_payment', 'processing')`),
  ],
);

/**
 * Every webhook event we have processed, keyed by Stripe's event id.
 *
 * The unique index is the idempotency guarantee. Stripe retries, and retries
 * happily deliver an event we already acted on — without this a redelivered
 * `payment_intent.succeeded` would post a second set of ledger entries.
 *
 * `project` records which project's tag the event carried. On a Stripe account
 * shared between projects, rows with a foreign tag are the evidence that the
 * filter is doing its job, so they are stored rather than dropped silently.
 */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    id: id(),
    stripeEventId: text().notNull(),
    type: text().notNull(),
    project: text(),
    /** Whether this project acted on it, or filtered it as another's. */
    handled: boolean().notNull().default(false),
    payload: jsonb().notNull(),
    receivedAt: createdAt(),
    processedAt: timestamp({ withTimezone: true }),
    /** Set when the handler threw, so a failed event is findable and replayable. */
    error: text(),
  },
  (table) => [
    uniqueIndex("stripe_webhook_events_event_key").on(table.stripeEventId),
    index("stripe_webhook_events_type_idx").on(table.type),
  ],
);

/**
 * Append-only money movement. Never updated: a correction is a new, opposing
 * row, so the history of what was believed and when survives intact.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    bookingId: uuid()
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    account: ledgerAccountEnum().notNull(),
    /** `credit` increases the account, `debit` decreases it. */
    direction: text().notNull(),
    amountCents: integer().notNull(),
    currency: text().notNull(),
    status: ledgerStatusEnum().notNull().default("accrued"),
    relatedStripeObjectId: text(),
    createdAt: createdAt(),
  },
  (table) => [
    index("ledger_entries_booking_idx").on(table.bookingId),
    index("ledger_entries_account_idx").on(table.account, table.status),
  ],
);

export const learnersRelations = relations(learners, ({ one, many }) => ({
  customerProfile: one(customerProfiles, {
    fields: [learners.customerProfileId],
    references: [customerProfiles.id],
  }),
  bookings: many(bookings),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  customerProfile: one(customerProfiles, {
    fields: [bookings.customerProfileId],
    references: [customerProfiles.id],
  }),
  learner: one(learners, {
    fields: [bookings.learnerId],
    references: [learners.id],
  }),
  requestedEducator: one(educatorProfiles, {
    fields: [bookings.educatorProfileId],
    references: [educatorProfiles.id],
    relationName: "requestedEducator",
  }),
  assignedEducator: one(educatorProfiles, {
    fields: [bookings.assignedEducatorId],
    references: [educatorProfiles.id],
    relationName: "assignedEducator",
  }),
  payments: many(payments),
  ledger: many(ledgerEntries),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, {
    fields: [payments.bookingId],
    references: [bookings.id],
  }),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  booking: one(bookings, {
    fields: [ledgerEntries.bookingId],
    references: [bookings.id],
  }),
}));
