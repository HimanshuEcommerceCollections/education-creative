import { relations } from "drizzle-orm";
import {
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
import { educatorApplicationStatusEnum, educatorVerificationStatusEnum } from "./enums.ts";

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * An educator's request to join, submitted from `/become-a-tutor`. Holds
 * pre-account data: **no `users` row exists at this point**, which is what makes
 * "educators can never self-create an active account" structurally true rather
 * than a policy someone has to remember.
 *
 * A pending or rejected applicant therefore has nothing to log in with. They
 * learn their outcome by email — see the status-notification decision.
 *
 * The invite token is *not* stored here (the doc put an `invite_token_hash`
 * column on this table); it goes in `email_tokens` with purpose `invite`, so
 * verification, reset, and invite all share one issue/consume implementation.
 */
export const educatorApplications = pgTable(
  "educator_applications",
  {
    id: id(),
    applicantName: text().notNull(),
    email: text().notNull(),
    phone: text(),
    /** Subject slugs from the apply form's select. */
    subjectsOfInterest: text().array().notNull().default([]),
    /** Free-text band from the form, e.g. "3-5". Not parsed into a number. */
    yearsExperience: text(),
    about: text().notNull(),
    status: educatorApplicationStatusEnum().notNull().default("submitted"),
    reviewedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp({ withTimezone: true }),
    /** Internal reviewer notes — never returned to the applicant. */
    reviewNotes: text(),
    /** Pass/fail reference from Stripe Identity or Persona. Never the ID itself. */
    backgroundCheckRef: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("educator_applications_status_idx").on(table.status),
    index("educator_applications_email_idx").on(table.email),
  ],
);

/**
 * The listable educator record. `userId` is null until an approval creates the
 * account, which is the seam the whole invite-only rule hangs off.
 *
 * Rate and subject tables are Phase 2; `minRateCents` is kept here now only
 * because the browse grid already renders a "from" price.
 */
export const educatorProfiles = pgTable(
  "educator_profiles",
  {
    id: id(),
    /** Null between profile creation and the invite being accepted. */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    applicationId: uuid().references(() => educatorApplications.id, {
      onDelete: "set null",
    }),
    slug: text().notNull(),
    name: text().notNull(),
    headline: text(),
    about: text().array().notNull().default([]),
    /**
     * Gates the child-safety invariant in §5: a booking cannot be confirmed and
     * no learner detail or in-home address may be revealed unless this is
     * `approved` with a current background check.
     */
    verificationStatus: educatorVerificationStatusEnum().notNull().default("pending"),
    backgroundCheckAt: timestamp({ withTimezone: true }),
    ratingCached: integer(),
    reviewCountCached: integer().notNull().default(0),
    minRateCents: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("educator_profiles_slug_key").on(table.slug),
    uniqueIndex("educator_profiles_user_key").on(table.userId),
    index("educator_profiles_verification_idx").on(table.verificationStatus),
  ],
);

export const educatorApplicationsRelations = relations(
  educatorApplications,
  ({ one }) => ({
    reviewer: one(users, {
      fields: [educatorApplications.reviewedBy],
      references: [users.id],
    }),
    profile: one(educatorProfiles, {
      fields: [educatorApplications.id],
      references: [educatorProfiles.applicationId],
    }),
  }),
);

export const educatorProfilesRelations = relations(educatorProfiles, ({ one }) => ({
  user: one(users, { fields: [educatorProfiles.userId], references: [users.id] }),
  application: one(educatorApplications, {
    fields: [educatorProfiles.applicationId],
    references: [educatorApplications.id],
  }),
}));
