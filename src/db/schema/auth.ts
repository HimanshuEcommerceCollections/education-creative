import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidv7 } from "../../lib/id.ts";
import {
  authProviderEnum,
  emailTokenPurposeEnum,
  userRoleEnum,
  userStatusEnum,
} from "./enums.ts";

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Every authenticating principal. Always an adult — minors are never users
 * (§4). Roles live in `userRoles`, never a column here, so one human can be
 * both a customer and an educator.
 *
 * Emails are normalised to lowercase at the Zod edge and additionally protected
 * by a unique index on `lower(email)`, which gives citext's case-insensitive
 * uniqueness without depending on the extension being installed.
 */
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text().notNull(),
    /** Null for an invited account that has not set a password yet, or OAuth-only. */
    passwordHash: text(),
    fullName: text().notNull(),
    phone: text(),
    status: userStatusEnum().notNull().default("active"),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    /** Set when the account holder attests to being an adult (signup / invite accept). */
    ageGateAttestedAt: timestamp({ withTimezone: true }),
    /** Consecutive failed password attempts; reset on success. Drives lockout. */
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    stripeCustomerId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("users_email_lower_key").on(sql`lower(${table.email})`),
    index("users_status_idx").on(table.status),
  ],
);

/**
 * Role grants. A user with no row here can authenticate but has no capability —
 * which is exactly the state of an educator applicant's account between
 * creation and approval, and is treated as such by the authz middleware.
 */
export const userRoles = pgTable(
  "user_roles",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum().notNull(),
    /** Null for the self-service customer grant and the CLI-seeded first admin. */
    grantedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    grantedAt: createdAt(),
  },
  (table) => [
    uniqueIndex("user_roles_user_role_key").on(table.userId, table.role),
    index("user_roles_user_idx").on(table.userId),
  ],
);

/** Which credential mechanisms a user can authenticate with. */
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: authProviderEnum().notNull(),
    /** The user id for `password`; the provider's subject claim for OAuth. */
    providerAccountId: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("auth_identities_provider_account_key").on(
      table.provider,
      table.providerAccountId,
    ),
    uniqueIndex("auth_identities_user_provider_key").on(table.userId, table.provider),
  ],
);

/**
 * Opaque, revocable sessions. Only the SHA-256 of `pepper + token` is stored,
 * so a database read cannot recover a usable credential.
 *
 * `activeRole` is resolved at login by highest privilege
 * (admin > coordinator > educator > customer) and pinned for the session's life.
 * `isStaff` is derived from it and drives the shorter idle window — it is a
 * property of the principal, not of which page they logged in from, because
 * this platform has a single `/login` for every role.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeRole: userRoleEnum().notNull(),
    isStaff: boolean().notNull().default(false),
    /** Rolling: extended on each authenticated request. */
    idleExpiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Hard ceiling: never extended, so a session cannot live forever. */
    absoluteExpiresAt: timestamp({ withTimezone: true }).notNull(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
    lastSeenAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_key").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    // Supports the pg-boss sweeper that deletes expired rows.
    index("sessions_idle_expires_idx").on(table.idleExpiresAt),
  ],
);

/**
 * Single-use, hashed, TTL-bounded tokens for email verification, password reset,
 * and educator/staff invites. One table rather than three because the mechanism
 * is identical and having one consume path means one place to get it right.
 *
 * Only the hash is stored, so a leaked table dump grants nothing.
 */
export const emailTokens = pgTable(
  "email_tokens",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: emailTokenPurposeEnum().notNull(),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("email_tokens_token_hash_key").on(table.tokenHash),
    index("email_tokens_user_purpose_idx").on(table.userId, table.purpose),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  roles: many(userRoles),
  identities: many(authIdentities),
  sessions: many(sessions),
  emailTokens: many(emailTokens),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const authIdentitiesRelations = relations(authIdentities, ({ one }) => ({
  user: one(users, { fields: [authIdentities.userId], references: [users.id] }),
}));

export const emailTokensRelations = relations(emailTokens, ({ one }) => ({
  user: one(users, { fields: [emailTokens.userId], references: [users.id] }),
}));
