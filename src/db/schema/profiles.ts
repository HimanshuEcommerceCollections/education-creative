import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { uuidv7 } from "../../lib/id.ts";
import { users } from "./auth.ts";
import { consentTypeEnum } from "./enums.ts";

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/**
 * Parent-side profile. `customer_profiles` is this project's rename of the
 * doc's `client_profiles`. Owns `learners` once Phase 3 lands.
 *
 * `subjectsOfInterest` is the optional chip selection from the signup form —
 * plain subject slugs, not a FK, because subjects are still static data in the
 * client until Phase 2 migrates them.
 */
export const customerProfiles = pgTable(
  "customer_profiles",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectsOfInterest: text().array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (table) => [uniqueIndex("customer_profiles_user_key").on(table.userId)],
);

/**
 * Versioned, hashed, stamped consent. Append-only in practice: a withdrawal is
 * a new row, never an edit, so the record of what was agreed to and when stays
 * intact.
 *
 * `textHash` is the SHA-256 of the exact consent copy shown to the user, so we
 * can prove which wording they accepted even after the copy changes.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    consentType: consentTypeEnum().notNull(),
    /** Semantic version of the copy, e.g. "signup-guardian-v1". */
    textVersion: text().notNull(),
    textHash: text().notNull(),
    /** How it was given, e.g. "checkbox:signup-form". */
    method: text().notNull(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (table) => [index("consent_records_user_type_idx").on(table.userId, table.consentType)],
);

export const customerProfilesRelations = relations(customerProfiles, ({ one }) => ({
  user: one(users, { fields: [customerProfiles.userId], references: [users.id] }),
}));

export const consentRecordsRelations = relations(consentRecords, ({ one }) => ({
  user: one(users, { fields: [consentRecords.userId], references: [users.id] }),
}));
