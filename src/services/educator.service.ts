import { and, asc, count, eq, isNull, sql } from "drizzle-orm";

import type {
  EducatorCommitment,
  EducatorProfile,
  EducatorListResponse,
  ListEducatorsQuery,
  SetEducatorVerification,
  StaffEducatorDetail,
  StaffEducatorProfile,
  StaffUpdateEducatorProfile,
  UpdateEducatorProfile,
} from "../contracts/educators.ts";
import type { EducatorDirectoryResponse } from "../contracts/reviews.ts";
import { db, type DbOrTx, type Tx } from "../db/client.ts";
import {
  bookings,
  educatorApplications,
  educatorProfiles,
  users,
} from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import {
  revokeAllSessionsForUser,
  type AuthenticatedPrincipal,
} from "./session.service.ts";

/**
 * Educator profiles — the record staff vet and the educator maintains.
 *
 * Two things here are load-bearing rather than administrative:
 *
 * - **`verificationStatus` is the child-safety gate (§5).** `setEducatorVerification`
 *   is the only writer outside the seed script: a confirm names an `approved`
 *   educator or fails, the assignment picker lists only `approved`, and both the
 *   educator's own session list and learner-detail access re-check it on every
 *   read. Suspending therefore takes effect immediately everywhere, with nothing
 *   to invalidate.
 * - **`subjects` is what the booking flow offers**, and the quote path rejects a
 *   topic that isn't in it. An empty list is not a neutral default; it is an
 *   incomplete profile, which is why the profile edits below exist at all.
 */

/** The educator's own view. No vetting reference — that's a record *about* them. */
const profileColumns = {
  slug: educatorProfiles.slug,
  name: educatorProfiles.name,
  headline: educatorProfiles.headline,
  about: educatorProfiles.about,
  subjects: educatorProfiles.subjects,
  verificationStatus: educatorProfiles.verificationStatus,
  backgroundCheckAt: educatorProfiles.backgroundCheckAt,
  minRateCents: educatorProfiles.minRateCents,
  createdAt: educatorProfiles.createdAt,
};

/**
 * The staff view: the same profile plus the account behind it.
 *
 * Both joins are `left` and both carry their predicate in the ON clause rather
 * than the WHERE — a profile exists before its invite is accepted, and moving
 * `deletedAt` into the WHERE would silently drop exactly the profiles that have
 * no user yet.
 */
const staffProfileColumns = {
  ...profileColumns,
  /** Never returned — `toStaffProfile` allowlists the response — but needed to
   * look up what this educator is committed to. */
  id: educatorProfiles.id,
  userId: educatorProfiles.userId,
  applicationId: educatorProfiles.applicationId,
  email: users.email,
  accountStatus: users.status,
  backgroundCheckRef: educatorApplications.backgroundCheckRef,
};

function toProfile(row: {
  slug: string;
  name: string;
  headline: string | null;
  about: string[];
  subjects: string[];
  verificationStatus: EducatorProfile["verificationStatus"];
  backgroundCheckAt: Date | null;
  minRateCents: number | null;
  createdAt: Date;
}): EducatorProfile {
  return {
    slug: row.slug,
    name: row.name,
    headline: row.headline,
    about: row.about,
    subjects: row.subjects,
    verificationStatus: row.verificationStatus,
    backgroundCheckAt: row.backgroundCheckAt?.toISOString() ?? null,
    minRateCents: row.minRateCents,
    createdAt: row.createdAt.toISOString(),
  };
}

function staffProfileQuery(dbOrTx: DbOrTx) {
  return dbOrTx
    .select(staffProfileColumns)
    .from(educatorProfiles)
    .leftJoin(
      users,
      and(eq(educatorProfiles.userId, users.id), isNull(users.deletedAt)),
    )
    .leftJoin(
      educatorApplications,
      eq(educatorProfiles.applicationId, educatorApplications.id),
    );
}

type StaffProfileRow = Awaited<ReturnType<typeof staffProfileQuery>>[number];

function toStaffProfile(row: StaffProfileRow): StaffEducatorProfile {
  return {
    ...toProfile(row),
    userId: row.userId,
    applicationId: row.applicationId,
    email: row.email,
    accountStatus: row.accountStatus,
    backgroundCheckRef: row.backgroundCheckRef,
  };
}

// ---------------------------------------------------------------------------
// The educator's own profile
// ---------------------------------------------------------------------------

/**
 * Resolves the signed-in educator's profile. Takes no identifier at all, so
 * there is nothing to tamper with to read someone else's.
 */
async function requireOwnProfile(userId: string) {
  const [profile] = await db
    .select({ id: educatorProfiles.id, ...profileColumns })
    .from(educatorProfiles)
    .where(and(eq(educatorProfiles.userId, userId), isNull(educatorProfiles.deletedAt)))
    .limit(1);

  if (!profile) {
    throw new AppError("forbidden", "This view is for educator accounts.");
  }
  return profile;
}

export async function getOwnEducatorProfile(
  principal: AuthenticatedPrincipal,
): Promise<EducatorProfile> {
  return toProfile(await requireOwnProfile(principal.userId));
}

/**
 * The educator edits their own profile.
 *
 * Editing is allowed whatever the verification status says — a `pending`
 * educator completing their profile is the normal case, and one whose check has
 * lapsed still needs to be able to correct it. What editing cannot change is
 * whether they are bookable: only staff move `verificationStatus`.
 */
export async function updateOwnEducatorProfile(
  input: UpdateEducatorProfile,
  principal: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<EducatorProfile> {
  const current = await requireOwnProfile(principal.userId);

  return db.transaction(async (tx) => {
    const updated = await applyProfileUpdate(tx, current.id, input);

    await recordAudit(tx, {
      actorId: principal.userId,
      actorRole: principal.activeRole,
      action: "educator.profile_updated",
      entityType: "educator_profiles",
      entityId: current.id,
      before: changedFields(current, input),
      after: input,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return toProfile(updated);
  });
}

// ---------------------------------------------------------------------------
// Staff surface
// ---------------------------------------------------------------------------

/**
 * The staff directory of educators, filterable by verification status — which is
 * the only way to answer "who is waiting on a background check?", the queue this
 * whole surface exists to work.
 */
/**
 * Free text against the name or any subject taught.
 *
 * The subject half is what makes it useful — "who can take Algebra?" is the
 * question a coordinator actually has — and it needs `unnest` because `subjects`
 * is an array column, where a plain `ILIKE` would only ever match the whole
 * array's text form.
 *
 * Binding the term as a parameter stops injection but not pattern abuse: `%` and
 * `_` are still wildcards once inside the value, so a search for `%` would match
 * every educator rather than none. They are escaped here, against Postgres's
 * default backslash escape.
 */
function matchesSearch(term: string) {
  const pattern = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return sql`(
    ${educatorProfiles.name} ilike ${pattern}
    or exists (
      select 1 from unnest(${educatorProfiles.subjects}) as subject
      where subject ilike ${pattern}
    )
  )`;
}

export async function listEducatorProfiles(
  query: ListEducatorsQuery,
): Promise<EducatorListResponse> {
  const where = and(
    isNull(educatorProfiles.deletedAt),
    query.verificationStatus
      ? eq(educatorProfiles.verificationStatus, query.verificationStatus)
      : undefined,
    query.q ? matchesSearch(query.q) : undefined,
  );

  const [rows, [totals]] = await Promise.all([
    staffProfileQuery(db)
      .where(where)
      .orderBy(asc(educatorProfiles.name))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(educatorProfiles).where(where),
  ]);

  const total = totals?.total ?? 0;

  return {
    items: rows.map(toStaffProfile),
    total,
    hasMore: query.offset + rows.length < total,
    limit: query.limit,
    offset: query.offset,
  };
}

/** How many commitments the detail view will show before it stops listing them. */
const COMMITMENT_LIMIT = 20;

/**
 * The sessions an educator is committed to and hasn't delivered yet.
 *
 * `confirmed` is the only status that means both "assigned to this person" and
 * "still to happen": `paid_unconfirmed` has no educator on it, and
 * `completed`/`no_show` are over. Read on the detail view alone — a directory of
 * fifty educators would pay this join fifty times to show something no row
 * displays.
 *
 * It exists because suspending an educator does not cancel what they were already
 * given, and there is no reassignment path yet, so whoever suspends them has to be
 * able to see what they are leaving unattended.
 */
async function loadCommitments(
  educatorProfileId: string,
): Promise<EducatorCommitment[]> {
  const rows = await db
    .select({
      reference: bookings.reference,
      preferredDate: bookings.preferredDate,
      preferredTime: bookings.preferredTime,
      subjectTopic: bookings.subjectTopic,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.assignedEducatorId, educatorProfileId),
        eq(bookings.status, "confirmed"),
      ),
    )
    // Soonest first: the ones that matter are the ones about to happen.
    .orderBy(asc(bookings.preferredDate), asc(bookings.preferredTime))
    .limit(COMMITMENT_LIMIT);

  return rows;
}

export async function getEducatorProfile(slug: string): Promise<StaffEducatorDetail> {
  const [row] = await staffProfileQuery(db)
    .where(and(eq(educatorProfiles.slug, slug), isNull(educatorProfiles.deletedAt)))
    .limit(1);

  if (!row) throw new AppError("not_found", "No such educator.");

  return {
    ...toStaffProfile(row),
    confirmedBookings: await loadCommitments(row.id),
  };
}

/**
 * Staff edit any profile. Same fields as the educator's own edit plus the
 * displayed name; the slug is not editable here, because it is a public URL that
 * may already be linked to and renaming it is a redirect problem, not a form.
 */
export async function updateEducatorProfileAsStaff(
  slug: string,
  input: StaffUpdateEducatorProfile,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<StaffEducatorProfile> {
  return db.transaction(async (tx) => {
    const current = await lockProfile(tx, slug);
    await applyProfileUpdate(tx, current.id, input);

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "educator.profile_updated",
      entityType: "educator_profiles",
      entityId: current.id,
      before: changedFields(current, input),
      after: input,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    const [row] = await staffProfileQuery(tx)
      .where(eq(educatorProfiles.id, current.id))
      .limit(1);

    return toStaffProfile(row!);
  });
}

/**
 * Sets an educator's verification status — the missing half of onboarding.
 *
 * Approval writes `backgroundCheckAt` as well as the status, because "approved"
 * without a date is a claim nobody can audit. The vendor's reference goes on the
 * application row, which is where the vetting record lives; a profile with no
 * application behind it (a seeded one) keeps the reference in the audit row
 * alone, and there is nowhere else for it to go without a schema change.
 *
 * `backgroundCheckAt` is deliberately not cleared on suspension: when the check
 * was cleared stays true afterwards, and the status is what gates access.
 */
export async function setEducatorVerification(
  slug: string,
  input: SetEducatorVerification,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<StaffEducatorProfile> {
  return db.transaction(async (tx) => {
    const current = await lockProfile(tx, slug);

    if (current.verificationStatus === input.status) {
      throw new AppError("conflict", `That educator is already ${input.status}.`);
    }

    await tx
      .update(educatorProfiles)
      .set({
        verificationStatus: input.status,
        ...(input.status === "approved" ? { backgroundCheckAt: new Date() } : {}),
      })
      .where(eq(educatorProfiles.id, current.id));

    if (input.status === "approved" && input.backgroundCheckRef && current.applicationId) {
      await tx
        .update(educatorApplications)
        .set({ backgroundCheckRef: input.backgroundCheckRef })
        .where(eq(educatorApplications.id, current.applicationId));
    }

    /*
     * A suspension has to end the sessions they are already signed in with.
     * `activeRole` is pinned at login and every read re-checks the *current*
     * verification status, but a live session is still a live session: without
     * this the suspension is advisory until it happens to idle out, which for an
     * educator is twelve hours. `userId` is null for a profile whose invite was
     * never accepted, and there is nothing to revoke in that case.
     */
    if (input.status === "suspended" && current.userId) {
      await revokeAllSessionsForUser(tx, current.userId);
    }

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "educator.verification_changed",
      entityType: "educator_profiles",
      entityId: current.id,
      before: {
        verificationStatus: current.verificationStatus,
        backgroundCheckAt: current.backgroundCheckAt?.toISOString() ?? null,
      },
      after: {
        slug: current.slug,
        verificationStatus: input.status,
        reason: input.reason,
        backgroundCheckRef: input.backgroundCheckRef ?? null,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    const [row] = await staffProfileQuery(tx)
      .where(eq(educatorProfiles.id, current.id))
      .limit(1);

    return toStaffProfile(row!);
  });
}

// ---------------------------------------------------------------------------
// Public directory
// ---------------------------------------------------------------------------

/**
 * Who can actually be booked — the first server-side answer to that question,
 * which the client has until now hardcoded in its own data files.
 *
 * Three conditions, each of them load-bearing:
 *
 * - **`approved`** is the child-safety gate (§5). A `pending` or `suspended`
 *   educator cannot be assigned a booking, so listing them would advertise a
 *   session that can only end in a refund.
 * - **not deleted** — there is no separate "listed" flag on the table; approval
 *   plus the absence of a delete stamp is what listing means today.
 * - **has at least one subject.** The booking flow validates a requested topic
 *   against this list, so a profile with an empty one is unbookable for every
 *   topic there is. Publishing it would be an offer nothing can accept.
 *
 * The projection is an explicit allowlist rather than the profile row: no
 * verification internals, no background-check date, no application id, and no
 * `userId` — a public page has no reason to know an educator's account exists,
 * let alone which account it is.
 */
export async function listPublicEducators(): Promise<EducatorDirectoryResponse> {
  const rows = await db
    .select({
      slug: educatorProfiles.slug,
      name: educatorProfiles.name,
      headline: educatorProfiles.headline,
      subjects: educatorProfiles.subjects,
      minRateCents: educatorProfiles.minRateCents,
      ratingCached: educatorProfiles.ratingCached,
      reviewCountCached: educatorProfiles.reviewCountCached,
    })
    .from(educatorProfiles)
    .where(
      and(
        eq(educatorProfiles.verificationStatus, "approved"),
        isNull(educatorProfiles.deletedAt),
        // `array_length` is null on an empty array, so this drops those rows too.
        sql`array_length(${educatorProfiles.subjects}, 1) > 0`,
      ),
    )
    .orderBy(asc(educatorProfiles.name));

  return {
    items: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      headline: row.headline,
      subjects: row.subjects,
      minRateCents: row.minRateCents,
      /*
       * `rating_cached` holds the average in tenths — 49 is 4.9 — because the
       * column is an integer and tenths are the only lossless way to keep a
       * one-decimal score in one. `review.service.ts` writes it; this is the only
       * other place that knows the scale, and it converts here so no client has
       * to.
       */
      rating: row.ratingCached === null ? null : row.ratingCached / 10,
      reviewCount: row.reviewCountCached,
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Takes the profile row for update. No joins here on purpose: Postgres refuses
 * `FOR UPDATE` on the nullable side of an outer join, and the account columns are
 * only read back for the response.
 */
async function lockProfile(tx: Tx, slug: string) {
  const [row] = await tx
    .select({
      id: educatorProfiles.id,
      slug: educatorProfiles.slug,
      name: educatorProfiles.name,
      headline: educatorProfiles.headline,
      about: educatorProfiles.about,
      subjects: educatorProfiles.subjects,
      applicationId: educatorProfiles.applicationId,
      /** Null until an invited educator accepts; a suspension has nothing to revoke then. */
      userId: educatorProfiles.userId,
      verificationStatus: educatorProfiles.verificationStatus,
      backgroundCheckAt: educatorProfiles.backgroundCheckAt,
    })
    .from(educatorProfiles)
    .where(and(eq(educatorProfiles.slug, slug), isNull(educatorProfiles.deletedAt)))
    .for("update")
    .limit(1);

  if (!row) throw new AppError("not_found", "No such educator.");
  return row;
}

/** Writes only the keys the caller sent, so a partial edit stays partial. */
async function applyProfileUpdate(
  tx: Tx,
  profileId: string,
  input: StaffUpdateEducatorProfile,
) {
  const [updated] = await tx
    .update(educatorProfiles)
    .set({
      ...("name" in input && input.name !== undefined ? { name: input.name } : {}),
      ...("headline" in input ? { headline: input.headline ?? null } : {}),
      ...("about" in input && input.about ? { about: input.about } : {}),
      // Deduped for the same reason the apply form dedupes: the list is compared
      // against a booking's topic, and a repeat carries no extra meaning.
      ...("subjects" in input && input.subjects
        ? { subjects: [...new Set(input.subjects)] }
        : {}),
    })
    .where(eq(educatorProfiles.id, profileId))
    .returning(profileColumns);

  return updated!;
}

/** The prior values of just the fields being changed, for the audit's `before`. */
function changedFields(
  current: {
    name: string;
    headline: string | null;
    about: string[];
    subjects: string[];
  },
  input: StaffUpdateEducatorProfile,
): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  if ("name" in input) before.name = current.name;
  if ("headline" in input) before.headline = current.headline;
  if ("about" in input) before.about = current.about;
  if ("subjects" in input) before.subjects = current.subjects;
  return before;
}
