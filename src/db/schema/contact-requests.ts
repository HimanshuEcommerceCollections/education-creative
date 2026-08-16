import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { uuidv7 } from "../../lib/id.ts";
import { users } from "./auth.ts";
import { contactReasonEnum, contactRequestStatusEnum } from "./enums.ts";

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Someone wrote in through the public contact form.
 *
 * The rows are unstructured PII typed by the public — people describe their
 * children in free text whatever a form asks for — so this is staff-only
 * everywhere, never exposed on a public read, and needs a retention answer that
 * the platform does not yet have.
 *
 * Deliberately **not** a message thread. Staff reply from their own mail client;
 * this table records who owns an enquiry and what came of it, because a platform
 * that stores half a conversation is worse than one that stores none — the half
 * it holds reads as the whole of it.
 *
 * `userId` is set only when a signed-in parent submits. It is what turns "someone
 * called Sarah emailed about a booking" into their actual bookings, and it is
 * nullable because most enquiries arrive before anyone has an account.
 */
export const contactRequests = pgTable(
  "contact_requests",
  {
    id: id(),

    name: text().notNull(),
    email: text().notNull(),
    phone: text(),
    reason: contactReasonEnum().notNull(),
    message: text().notNull(),

    status: contactRequestStatusEnum().notNull().default("new"),
    /** The coordinator who picked it up. Null while it is nobody's. */
    assignedTo: uuid().references(() => users.id, { onDelete: "set null" }),
    /** The sender's account, when they were signed in. */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),

    /**
     * The abuse signal for a public write endpoint, and the only way to tell a
     * flood from a busy week. Trustworthy only as far as the forwarded address
     * is — see `plugins/request-context.ts`.
     */
    ip: text(),
    userAgent: text(),

    /**
     * Stamped when it stops being unattended, not when it is finished. Without
     * both of these there is no way to answer "how long do people wait", which is
     * the only measure of whether this queue is being worked.
     */
    firstRespondedAt: timestamp({ withTimezone: true }),
    resolvedAt: timestamp({ withTimezone: true }),
    /** What actually came of it, for whoever reads this next. */
    resolutionNote: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** The queue: what is unattended, oldest first. */
    index("contact_requests_status_idx").on(table.status, table.createdAt),
    index("contact_requests_assigned_idx").on(table.assignedTo),
    /** "Has this person written in before?", asked from a detail page. */
    index("contact_requests_email_idx").on(table.email),
  ],
);

export const contactRequestsRelations = relations(contactRequests, ({ one }) => ({
  assignee: one(users, {
    fields: [contactRequests.assignedTo],
    references: [users.id],
    relationName: "contactAssignee",
  }),
  sender: one(users, {
    fields: [contactRequests.userId],
    references: [users.id],
    relationName: "contactSender",
  }),
}));
