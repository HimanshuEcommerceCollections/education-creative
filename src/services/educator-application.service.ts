import { and, desc, eq, isNull, sql as rawSql } from "drizzle-orm";

import type {
  SubmitEducatorApplication,
  EducatorApplicationStatus,
} from "../contracts/educator-applications.ts";
import { db } from "../db/client.ts";
import { educatorApplications, educatorProfiles, users } from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { createInvitedUser, type RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import { trySend } from "./email/index.ts";
import {
  applicationReceivedTemplate,
  applicationRejectedTemplate,
  educatorInviteTemplate,
} from "./email/templates.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/** Statuses a fresh application may not duplicate. */
const OPEN_STATUSES: EducatorApplicationStatus[] = ["submitted", "in_review"];

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

export async function listEducatorApplications(query: {
  status?: EducatorApplicationStatus;
  limit: number;
  offset: number;
}) {
  return db
    .select()
    .from(educatorApplications)
    .where(query.status ? eq(educatorApplications.status, query.status) : undefined)
    .orderBy(desc(educatorApplications.createdAt))
    .limit(query.limit)
    .offset(query.offset);
}

export async function getEducatorApplication(id: string) {
  const [row] = await db
    .select()
    .from(educatorApplications)
    .where(eq(educatorApplications.id, id))
    .limit(1);

  if (!row) throw new AppError("not_found", "No such application.");
  return row;
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
  const application = await getEducatorApplication(id);

  if (application.status === "approved") {
    throw new AppError(
      "conflict",
      "This application is already approved — the educator has an account.",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(educatorApplications)
      .set({
        status: input.status,
        reviewedBy: reviewer.userId,
        reviewedAt: new Date(),
        reviewNotes: input.reviewNotes ?? application.reviewNotes,
      })
      .where(eq(educatorApplications.id, id));

    await recordAudit(tx, {
      actorId: reviewer.userId,
      actorRole: reviewer.activeRole,
      action: `educator_application.${input.status}`,
      entityType: "educator_applications",
      entityId: id,
      before: { status: application.status },
      after: { status: input.status },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
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
 * invariant in §5 keys off the latter. A coordinator marks verification
 * approved once the background check is on file.
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
): Promise<{ userId: string; educatorProfileId: string }> {
  const application = await getEducatorApplication(id);

  if (application.status === "approved") {
    throw new AppError("conflict", "This application is already approved.");
  }
  if (application.status === "rejected") {
    throw new AppError(
      "conflict",
      "This application was rejected. Ask the applicant to reapply.",
    );
  }

  // An address that already has an account can't be given a second one; link
  // the existing user to an educator role instead (a parent who applies to
  // teach). Handled explicitly rather than crashing on the unique index.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(rawSql`lower(${users.email}) = ${application.email}`, isNull(users.deletedAt)))
    .limit(1);

  if (existingUser) {
    throw new AppError(
      "conflict",
      "That email already has an account. Grant the educator role to the existing " +
        "user instead of approving this application.",
      { logContext: { applicationId: id, existingUserId: existingUser.id } },
    );
  }

  const slug = input.slug ?? (await uniqueSlugFor(application.applicantName));

  const result = await db.transaction(async (tx) => {
    const { userId, token } = await createInvitedUser(tx, {
      email: application.email,
      fullName: application.applicantName,
      role: "educator",
      grantedBy: approver.userId,
      phone: application.phone,
    });

    const [profile] = await tx
      .insert(educatorProfiles)
      .values({
        userId,
        applicationId: id,
        slug,
        name: application.applicantName,
        headline: input.headline ?? null,
        verificationStatus: "pending",
      })
      .returning({ id: educatorProfiles.id });

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
      after: { status: "approved", userId, educatorProfileId: profile!.id, slug },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return { userId, token, educatorProfileId: profile!.id };
  });

  // If this fails the account and profile still exist; the invite token is live
  // for 7 days, and the logged context is what an operator needs to resend it.
  await trySend(
    { ...educatorInviteTemplate(application.applicantName, result.token), to: application.email },
    { purpose: "educator_invite", userId: result.userId },
  );

  return { userId: result.userId, educatorProfileId: result.educatorProfileId };
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

/** Appends -2, -3, … until free. Slugs are public URLs, so collisions are real. */
async function uniqueSlugFor(name: string): Promise<string> {
  const base = slugify(name) || "educator";

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const [taken] = await db
      .select({ id: educatorProfiles.id })
      .from(educatorProfiles)
      .where(eq(educatorProfiles.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }

  throw new AppError("conflict", "Could not derive a free profile slug — set one manually.");
}
