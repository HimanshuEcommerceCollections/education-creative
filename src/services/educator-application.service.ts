import { and, count, desc, eq, isNull, sql as rawSql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";

import type {
  EducatorApplication,
  EducatorApplicationListResponse,
  EducatorApplicationStatus,
  SubmitEducatorApplication,
} from "../contracts/educator-applications.ts";
import { FLAG_MESSAGES } from "../constants.ts";
import { db, type Tx } from "../db/client.ts";
import { educatorApplications, educatorProfiles, users } from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { USERS_EMAIL_CONSTRAINT, isUniqueViolation } from "../lib/pg-errors.ts";
import { createInvitedUser, type RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import { assertFlagEnabled } from "./config.service.ts";
import { trySend } from "./email/index.ts";
import {
  applicationReceivedTemplate,
  applicationRejectedTemplate,
  educatorInviteTemplate,
} from "./email/templates.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";
import { resendInvite } from "./staff.service.ts";

/** Statuses a fresh application may not duplicate. */
const OPEN_STATUSES: EducatorApplicationStatus[] = ["submitted", "in_review"];

/**
 * The columns `educatorApplicationSchema` allows. Named once and projected
 * explicitly, because `select()` with no column list returns whatever the table
 * grows next — the read equivalent of a mass assignment.
 */
const applicationColumns = {
  id: educatorApplications.id,
  applicantName: educatorApplications.applicantName,
  email: educatorApplications.email,
  phone: educatorApplications.phone,
  subjectsOfInterest: educatorApplications.subjectsOfInterest,
  yearsExperience: educatorApplications.yearsExperience,
  about: educatorApplications.about,
  status: educatorApplications.status,
  reviewedBy: educatorApplications.reviewedBy,
  reviewedAt: educatorApplications.reviewedAt,
  reviewNotes: educatorApplications.reviewNotes,
  backgroundCheckRef: educatorApplications.backgroundCheckRef,
  createdAt: educatorApplications.createdAt,
};

type ApplicationRow = Pick<
  InferSelectModel<typeof educatorApplications>,
  keyof typeof applicationColumns
>;

function toApplication(row: ApplicationRow): EducatorApplication {
  return {
    ...row,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Records a public application. Creates **no** account — that is the whole point
 * of this table, and it's what makes "educators can never self-create an active
 * account" a structural property rather than a rule to remember.
 *
 * Returns nothing useful on purpose: the route replies with the same
 * confirmation whether this was a first submission or a duplicate, so the
 * endpoint can't be used to discover which educators have already applied or
 * been approved.
 */
export async function submitEducatorApplication(
  input: SubmitEducatorApplication,
  ctx: RequestContext,
): Promise<void> {
  await assertFlagEnabled("educatorApplicationsOpen", FLAG_MESSAGES.applicationsClosed);

  const [existingOpen] = await db
    .select({ id: educatorApplications.id, status: educatorApplications.status })
    .from(educatorApplications)
    .where(rawSql`lower(${educatorApplications.email}) = ${input.email}`)
    .orderBy(desc(educatorApplications.createdAt))
    .limit(1);

  // Already in the queue, or already approved — silently accept and stop.
  if (
    existingOpen &&
    (OPEN_STATUSES.includes(existingOpen.status) || existingOpen.status === "approved")
  ) {
    return;
  }

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(educatorApplications)
      .values({
        applicantName: input.applicantName,
        email: input.email,
        phone: input.phone ?? null,
        subjectsOfInterest: [...new Set(input.subjectsOfInterest)],
        yearsExperience: input.yearsExperience ?? null,
        about: input.about,
        status: "submitted",
      })
      .returning({ id: educatorApplications.id });

    await recordAudit(tx, {
      action: "educator_application.submitted",
      entityType: "educator_applications",
      entityId: row!.id,
      after: { email: input.email, subjects: input.subjectsOfInterest },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return row!.id;
  });

  await trySend(
    { ...applicationReceivedTemplate(input.applicantName), to: input.email },
    { purpose: "application_received" },
  );

}

/**
 * The review queue, newest first, filtered server-side.
 *
 * The count is returned alongside because the ordering makes the window
 * misleading on its own: with more applications than one page holds, the ones
 * that fall off the end are the oldest — which for an unreviewed application is
 * the one that has been waiting longest.
 */
export async function listEducatorApplications(query: {
  status?: EducatorApplicationStatus;
  limit: number;
  offset: number;
}): Promise<EducatorApplicationListResponse> {
  const where = query.status
    ? eq(educatorApplications.status, query.status)
    : undefined;

  const [rows, [totals]] = await Promise.all([
    db
      .select(applicationColumns)
      .from(educatorApplications)
      .where(where)
      .orderBy(desc(educatorApplications.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(educatorApplications).where(where),
  ]);

  const total = totals?.total ?? 0;

  return {
    items: rows.map(toApplication),
    total,
    hasMore: query.offset + rows.length < total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getEducatorApplication(id: string): Promise<EducatorApplication> {
  const [row] = await db
    .select(applicationColumns)
    .from(educatorApplications)
    .where(eq(educatorApplications.id, id))
    .limit(1);

  if (!row) throw new AppError("not_found", "No such application.");
  return toApplication(row);
}

/**
 * Takes the application row for update and returns what a decision needs.
 *
 * Both decisions start here. The status check and the write have to be one
 * atomic step: with a plain select, two coordinators clicking at the same moment
 * both pass the check, and for approval the loser only discovers it when the
 * users-email index rejects the second account.
 */
async function lockApplication(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: educatorApplications.id,
      applicantName: educatorApplications.applicantName,
      email: educatorApplications.email,
      phone: educatorApplications.phone,
      status: educatorApplications.status,
      reviewNotes: educatorApplications.reviewNotes,
      backgroundCheckRef: educatorApplications.backgroundCheckRef,
    })
    .from(educatorApplications)
    .where(eq(educatorApplications.id, id))
    .for("update")
    .limit(1);

  if (!row) throw new AppError("not_found", "No such application.");
  return row;
}

/** The two states a decision can no longer be made from. */
function assertDecidable(status: EducatorApplicationStatus): void {
  if (status === "approved") {
    throw new AppError(
      "conflict",
      "This application is already approved — the educator has an account.",
    );
  }
  // Terminal, and terminal in both directions: the applicant has already had the
  // email saying so, and reopening it would let a rejected applicant be approved
  // on the strength of a decision that was communicated as final.
  if (status === "rejected") {
    throw new AppError(
      "conflict",
      "This application was rejected, and that's final. Ask the applicant to reapply.",
    );
  }
}

/**
 * Moves an application to `in_review` or `rejected`. Approval is deliberately a
 * different endpoint — it has side effects (account, role, profile, invite) that
 * a status change should not be able to trigger by accident.
 */
export async function reviewEducatorApplication(
  id: string,
  input: { status: "in_review" | "rejected"; reviewNotes?: string },
  reviewer: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<void> {
  const application = await db.transaction(async (tx) => {
    const locked = await lockApplication(tx, id);
    assertDecidable(locked.status);

    await tx
      .update(educatorApplications)
      .set({
        status: input.status,
        reviewedBy: reviewer.userId,
        reviewedAt: new Date(),
        reviewNotes: input.reviewNotes ?? locked.reviewNotes,
      })
      .where(eq(educatorApplications.id, id));

    await recordAudit(tx, {
      actorId: reviewer.userId,
      actorRole: reviewer.activeRole,
      action: `educator_application.${input.status}`,
      entityType: "educator_applications",
      entityId: id,
      before: { status: locked.status },
      after: { status: input.status },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return locked;
  });

  if (input.status === "rejected") {
    await trySend(
      { ...applicationRejectedTemplate(application.applicantName), to: application.email },
      { purpose: "application_rejected" },
    );
  }
}

/**
 * The approval step. In one transaction: creates an `invited` user, grants the
 * educator role, creates the `educator_profiles` row, marks the application
 * approved, issues the invite token, and audits all of it. Then emails the
 * invite.
 *
 * The profile starts `pending`, not `approved` — listing an educator and
 * clearing them for a booking are separate gates, and the child-safety
 * invariant in §5 keys off the latter. Staff move it to `approved` through
 * `PATCH /educators/:slug/verification` once the background check is on file.
 *
 * `emailSent` is returned rather than assumed: the invite is the only way this
 * account ever gets a password, so an operator told "the invite is on its way"
 * when the provider refused it has no reason to reach for the resend path.
 */
export async function approveEducatorApplication(
  id: string,
  input: {
    slug?: string;
    headline?: string;
    backgroundCheckRef?: string;
    reviewNotes?: string;
  },
  approver: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{
  userId: string;
  educatorProfileId: string;
  slug: string;
  emailSent: boolean;
}> {
  const result = await db
    .transaction(async (tx) => {
      const application = await lockApplication(tx, id);
      assertDecidable(application.status);

      // An address that already has an account can't be given a second one; link
      // the existing user to an educator role instead (a parent who applies to
      // teach). Handled explicitly rather than crashing on the unique index.
      const [existingUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(rawSql`lower(${users.email}) = ${application.email}`, isNull(users.deletedAt)),
        )
        .limit(1);

      if (existingUser) {
        throw new AppError(
          "conflict",
          "That email already has an account. Grant the educator role to the existing " +
            "user instead of approving this application.",
          { logContext: { applicationId: id, existingUserId: existingUser.id } },
        );
      }

      const { userId, token } = await createInvitedUser(tx, {
        email: application.email,
        fullName: application.applicantName,
        role: "educator",
        grantedBy: approver.userId,
        phone: application.phone,
      });

      const profile = await insertEducatorProfile(tx, {
        userId,
        applicationId: id,
        name: application.applicantName,
        headline: input.headline ?? null,
        requestedSlug: input.slug,
      });

      await tx
        .update(educatorApplications)
        .set({
          status: "approved",
          reviewedBy: approver.userId,
          reviewedAt: new Date(),
          reviewNotes: input.reviewNotes ?? application.reviewNotes,
          backgroundCheckRef: input.backgroundCheckRef ?? application.backgroundCheckRef,
        })
        .where(eq(educatorApplications.id, id));

      await recordAudit(tx, {
        actorId: approver.userId,
        actorRole: approver.activeRole,
        action: "educator_application.approved",
        entityType: "educator_applications",
        entityId: id,
        before: { status: application.status },
        after: {
          status: "approved",
          userId,
          educatorProfileId: profile.id,
          slug: profile.slug,
        },
        ip: ctx.ip,
        requestId: ctx.requestId,
      });

      return {
        userId,
        token,
        educatorProfileId: profile.id,
        slug: profile.slug,
        applicantName: application.applicantName,
        email: application.email,
      };
    })
    .catch((error: unknown) => {
      /*
       * The row lock and the pre-check above serialise approvals of the *same*
       * application; the index is what covers two different applications from the
       * same person. Matched to the email index specifically — any other unique
       * violation in this transaction is a bug and must surface as one.
       */
      if (isUniqueViolation(error, USERS_EMAIL_CONSTRAINT)) {
        throw new AppError("email_in_use", "That email already has an account.", {
          fieldErrors: { email: "That email already has an account." },
        });
      }
      throw error;
    });

  // If this fails the account and profile still exist and the token is live for
  // 7 days; `emailSent: false` is what tells the operator to resend it.
  const emailSent = await trySend(
    { ...educatorInviteTemplate(result.applicantName, result.token), to: result.email },
    { purpose: "educator_invite", userId: result.userId },
  );

  return {
    userId: result.userId,
    educatorProfileId: result.educatorProfileId,
    slug: result.slug,
    emailSent,
  };
}

/**
 * Re-sends the invite for an approved application whose account is still
 * `invited`. One provider blip otherwise orphans the account permanently: the
 * educator has nothing to sign in with, and approval can't be repeated.
 */
export async function resendEducatorApplicationInvite(
  id: string,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ emailSent: boolean }> {
  const [profile] = await db
    .select({ userId: educatorProfiles.userId })
    .from(educatorProfiles)
    .where(
      and(
        eq(educatorProfiles.applicationId, id),
        isNull(educatorProfiles.deletedAt),
      ),
    )
    .limit(1);

  if (!profile?.userId) {
    throw new AppError(
      "not_found",
      "That application has no educator account yet — approve it first.",
    );
  }

  return resendInvite(profile.userId, actor, ctx);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/**
 * Inserts the profile, appending -2, -3, … to a derived slug until one is free.
 * Slugs are public URLs, so collisions are real.
 *
 * `onConflictDoNothing` on the slug index rather than a pre-flight SELECT: a
 * check-then-insert loses to a concurrent approval, and letting the violation
 * raise would abort the whole transaction instead of leaving the next candidate
 * available to try. A slug staff chose explicitly is never silently altered —
 * they get told it's taken.
 */
async function insertEducatorProfile(
  tx: Tx,
  input: {
    userId: string;
    applicationId: string;
    name: string;
    headline: string | null;
    requestedSlug?: string;
  },
): Promise<{ id: string; slug: string }> {
  const base = input.requestedSlug ?? (slugify(input.name) || "educator");
  const attempts = input.requestedSlug ? 1 : 50;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;

    const [row] = await tx
      .insert(educatorProfiles)
      .values({
        userId: input.userId,
        applicationId: input.applicationId,
        slug: candidate,
        name: input.name,
        headline: input.headline,
        verificationStatus: "pending",
      })
      .onConflictDoNothing({ target: educatorProfiles.slug })
      .returning({ id: educatorProfiles.id, slug: educatorProfiles.slug });

    if (row) return row;
  }

  if (input.requestedSlug) {
    throw new AppError("conflict", `The profile URL "${base}" is already taken.`, {
      fieldErrors: { slug: "Already taken — choose another." },
    });
  }

  throw new AppError("conflict", "Could not derive a free profile slug — set one manually.");
}
