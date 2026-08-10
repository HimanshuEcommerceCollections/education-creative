import { relations } from "drizzle-orm";
import {
  boolean,
  char,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidv7 } from "../../lib/id.ts";
import { users } from "./auth.ts";
import { educatorProfiles } from "./educators.ts";

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/**
 * Pricing rules (ARCHITECTURE.md §7). Money is integer cents, never float, and
 * the rule tables are **effective-dated and append-only**: an "edit" closes the
 * current row (`effective_to = now`) and inserts a new one in the same
 * transaction. The row in force at time *t* is the one with
 * `effective_from <= t` and (`effective_to` is null or `> t`) — which is what
 * lets a quote issued yesterday be replayed exactly, and gives every money edit
 * a built-in history without a separate versions table.
 */

/**
 * Subject categories. At launch these are the six site categories (tutoring,
 * music, …) — the fine-grained topics an educator teaches ("Piano", "Algebra")
 * stay free text on their profile. Rate bands hang off this table, so it must
 * exist before anything is priced.
 */
export const subjects = pgTable(
  "subjects",
  {
    id: id(),
    slug: text().notNull(),
    title: text().notNull(),
    description: text(),
    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("subjects_slug_key").on(table.slug)],
);

/**
 * Admin-set [min, suggested, max] per subject, in cents per hour. The band is
 * the guardrail every educator rate is validated against, and `suggested` is
 * what a guest sees where no educator is named. `min ≤ suggested ≤ max` is
 * enforced at the Zod edge, plus the global sanity band that rejects the
 * $5,500-instead-of-$55 typo.
 */
export const subjectRateBands = pgTable(
  "subject_rate_bands",
  {
    id: id(),
    subjectId: uuid()
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    minCents: integer().notNull(),
    suggestedCents: integer().notNull(),
    maxCents: integer().notNull(),
    currency: char({ length: 3 }).notNull().default("USD"),
    effectiveFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Null = the row currently in force. */
    effectiveTo: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("subject_rate_bands_subject_idx").on(table.subjectId, table.effectiveTo),
  ],
);

/**
 * An educator's hourly rate for a subject, validated within that subject's band
 * when written. Staff-set at launch (§12.3 default); educator self-service
 * within the band is the planned fast-follow and needs no schema change.
 */
export const educatorRates = pgTable(
  "educator_rates",
  {
    id: id(),
    educatorProfileId: uuid()
      .notNull()
      .references(() => educatorProfiles.id, { onDelete: "cascade" }),
    subjectId: uuid()
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    rateCents: integer().notNull(),
    currency: char({ length: 3 }).notNull().default("USD"),
    effectiveFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("educator_rates_educator_idx").on(
      table.educatorProfileId,
      table.subjectId,
      table.effectiveTo,
    ),
  ],
);

/**
 * The format differential: `in_home = base × multiplier + travel flat`. The
 * multiplier is stored in **basis points** (10000 = ×1.0) so the whole pricing
 * path stays in integer arithmetic. One global row in force at a time; online
 * is always ×1 by definition and has no column.
 */
export const formatPolicies = pgTable(
  "format_policies",
  {
    id: id(),
    inHomeMultiplierBps: integer().notNull().default(10000),
    travelFlatCents: integer().notNull().default(0),
    effectiveFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("format_policies_effective_idx").on(table.effectiveTo)],
);

export const subjectsRelations = relations(subjects, ({ many }) => ({
  rateBands: many(subjectRateBands),
  educatorRates: many(educatorRates),
}));

export const subjectRateBandsRelations = relations(subjectRateBands, ({ one }) => ({
  subject: one(subjects, {
    fields: [subjectRateBands.subjectId],
    references: [subjects.id],
  }),
}));

export const educatorRatesRelations = relations(educatorRates, ({ one }) => ({
  educator: one(educatorProfiles, {
    fields: [educatorRates.educatorProfileId],
    references: [educatorProfiles.id],
  }),
  subject: one(subjects, {
    fields: [educatorRates.subjectId],
    references: [subjects.id],
  }),
}));
