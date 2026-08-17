import { relations } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { uuidv7 } from "../../lib/id.ts";
import { users } from "./auth.ts";
import { bookings } from "./bookings.ts";
import { educatorProfiles } from "./educators.ts";
import { reviewStatusEnum } from "./enums.ts";
import { customerProfiles } from "./profiles.ts";

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * A parent's review of a session that actually happened.
 *
 * **`bookingId` is NOT NULL and UNIQUE, and that is the whole design** (§6). A
 * review has to be anchored to one completed, paid booking, which makes the two
 * failure modes of public ratings structurally impossible rather than
 * policed: nobody can review an educator they never booked, and nobody can review
 * the same session twice to move an average. It is also why there is no way to
 * write a review from a seed script or an admin screen without first creating the
 * booking behind it.
 *
 * `educatorProfileId` is the **assigned** educator — who actually taught — not the
 * one originally requested. A coordinator may substitute, and the review belongs to
 * the person who turned up.
 *
 * The four facet columns are nullable because the rating that matters is
 * `overallRating`; a parent who scores the session out of five and leaves is a
 * complete review. Averages over the facets are therefore computed only across the
 * rows that supplied them, so a breakdown is either real or absent.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    bookingId: uuid()
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    customerProfileId: uuid()
      .notNull()
      .references(() => customerProfiles.id, { onDelete: "restrict" }),
    educatorProfileId: uuid()
      .notNull()
      .references(() => educatorProfiles.id, { onDelete: "restrict" }),

    /** 1–5. Range is enforced at the contract edge, like every other bounded input. */
    overallRating: integer().notNull(),
    communicationRating: integer(),
    knowledgeRating: integer(),
    punctualityRating: integer(),
    patienceRating: integer(),

    /** Optional: a score with no words is still a review. */
    body: text(),

    /**
     * Nothing reaches a public page without a human decision. Reviews concern named
     * educators and are written by parents about sessions involving their children,
     * so publication is an explicit act by staff rather than the default.
     */
    status: reviewStatusEnum().notNull().default("pending"),
    moderatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    moderatedAt: timestamp({ withTimezone: true }),
    moderationNote: text(),
    publishedAt: timestamp({ withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** One review per session — see the note above. */
    uniqueIndex("reviews_booking_key").on(table.bookingId),
    /** The public read: an educator's published reviews, newest first. */
    index("reviews_educator_status_idx").on(table.educatorProfileId, table.status),
    /** The moderation queue. */
    index("reviews_status_idx").on(table.status),
    index("reviews_customer_idx").on(table.customerProfileId),
  ],
);

export const reviewsRelations = relations(reviews, ({ one }) => ({
  booking: one(bookings, { fields: [reviews.bookingId], references: [bookings.id] }),
  customerProfile: one(customerProfiles, {
    fields: [reviews.customerProfileId],
    references: [customerProfiles.id],
  }),
  educatorProfile: one(educatorProfiles, {
    fields: [reviews.educatorProfileId],
    references: [educatorProfiles.id],
  }),
  moderator: one(users, { fields: [reviews.moderatedBy], references: [users.id] }),
}));
