import { and, asc, count, desc, eq, sql } from "drizzle-orm";

import type {
  ContactReason,
  ContactRequestListResponse,
  ContactRequestQuery,
  ContactRequestRecord,
  ContactRequestStatus,
  SubmitContactRequest,
  UpdateContactRequest,
} from "../contracts/contact-requests.ts";
import { db, type DbOrTx } from "../db/client.ts";
import { contactRequests, users } from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import { trySend } from "./email/index.ts";
import { contactRequestReceivedTemplate } from "./email/templates.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/**
 * The public contact form and the queue staff work it from.
 *
 * Two properties hold throughout. **Nothing here is ever read publicly** — the
 * rows are free-text PII typed by strangers, so every read below sits behind
 * `requireStaff` and the sender gets an acknowledgement email and nothing else.
 * And **this is not a message thread**: staff reply from their own mail client,
 * so what is recorded is who owns an enquiry and what came of it, never a reply
 * body.
 */

/**
 * The columns `contactRequestSchema` allows. Named once and projected
 * explicitly, because `select()` with no column list returns whatever the table
 * grows next — and this table's next column is as likely as not to be another
 * piece of a stranger's private life.
 */
const contactRequestColumns = {
  id: contactRequests.id,
  name: contactRequests.name,
  email: contactRequests.email,
  phone: contactRequests.phone,
  reason: contactRequests.reason,
  message: contactRequests.message,
  status: contactRequests.status,
  assignedToId: contactRequests.assignedTo,
  assignedToName: users.fullName,
  senderUserId: contactRequests.userId,
  firstRespondedAt: contactRequests.firstRespondedAt,
  resolvedAt: contactRequests.resolvedAt,
  resolutionNote: contactRequests.resolutionNote,
  createdAt: contactRequests.createdAt,
};

interface ContactRequestRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  reason: ContactReason;
  message: string;
  status: ContactRequestStatus;
  assignedToId: string | null;
  assignedToName: string | null;
  senderUserId: string | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

function toRecord(row: ContactRequestRow): ContactRequestRecord {
  return {
    ...row,
    assignedToName: row.assignedToName ?? null,
    firstRespondedAt: row.firstRespondedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One enquiry with its assignee resolved to a name. The join is `left` because
 * `assigned_to` is `on delete set null` and unheld rows are the normal case —
 * an inner join would hide the whole unattended queue.
 */
function selectRecords(dbOrTx: DbOrTx) {
  return dbOrTx
    .select(contactRequestColumns)
    .from(contactRequests)
    .leftJoin(users, eq(users.id, contactRequests.assignedTo));
}

// ---------------------------------------------------------------------------
// The public write
// ---------------------------------------------------------------------------

/**
 * Records an enquiry from the public form, then acknowledges it.
 *
 * `senderUserId` is set only when the submitter happened to be signed in. It is
 * what turns "someone called Sarah wrote about a booking" into their actual
 * bookings, and it is null for most enquiries because most arrive before anyone
 * has an account.
 *
 * The store commits before the email is attempted: an acknowledgement that never
 * left is a person waiting for a reply, while a lost row is a person nobody knows
 * wrote at all.
 */
export async function submitContactRequest(
  input: SubmitContactRequest,
  ctx: RequestContext,
  senderUserId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(contactRequests)
      .values({
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        reason: input.reason,
        message: input.message,
        status: "new",
        userId: senderUserId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .returning({ id: contactRequests.id });

    await recordAudit(tx, {
      // Anonymous by design. A submission attributed to an invented actor would
      // read, forever, as something a person on the platform did.
      actorId: senderUserId,
      action: "contact_request.submitted",
      entityType: "contact_requests",
      entityId: row!.id,
      // The reason and the fact of it, not the prose: the message is on the row,
      // and copying a stranger's free text into an append-only log would outlive
      // any later deletion of it.
      after: { reason: input.reason, email: input.email, hasPhone: Boolean(input.phone) },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });

  await trySend(
    {
      ...contactRequestReceivedTemplate({ name: input.name, message: input.message }),
      to: input.email,
    },
    {
      purpose: "contact_request_received",
      ...(senderUserId ? { userId: senderUserId } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// The staff queue
// ---------------------------------------------------------------------------

/**
 * How many sit in each status, over the whole table and ignoring both filters.
 *
 * Deliberately unfiltered: the number that matters is how many nobody has
 * touched, and it has to stay on screen for a coordinator reading their own
 * resolved list — which is exactly the view where `mine` and `status` would
 * otherwise reduce it to zero.
 */
async function statusCounts(): Promise<ContactRequestListResponse["counts"]> {
  const [row] = await db
    .select({
      new: sql<number>`(count(*) filter (where ${contactRequests.status} = 'new'))::int`,
      in_progress: sql<number>`(count(*) filter (where ${contactRequests.status} = 'in_progress'))::int`,
      resolved: sql<number>`(count(*) filter (where ${contactRequests.status} = 'resolved'))::int`,
      spam: sql<number>`(count(*) filter (where ${contactRequests.status} = 'spam'))::int`,
    })
    .from(contactRequests);

  return {
    new: row?.new ?? 0,
    in_progress: row?.in_progress ?? 0,
    resolved: row?.resolved ?? 0,
    spam: row?.spam ?? 0,
  };
}

/** The statuses where the oldest row is the most urgent one. */
const OPEN_STATUSES: ContactRequestStatus[] = ["new", "in_progress"];

/**
 * The order the queue is worked in.
 *
 * Open work is oldest-first, because for an enquiry nobody has answered the
 * longest wait is the one doing the damage — the opposite of the newest-first
 * ordering the review and application queues use, where the backlog is a
 * decision rather than a person waiting. Closed work is newest-first: `resolved`
 * and `spam` are read as a record of what just happened, not a list to work
 * through.
 *
 * Filtered to one status this is a plain column order, so the
 * `(status, created_at)` index serves it. Unfiltered, the open statuses are
 * lifted above the closed ones first — otherwise page one of an unfiltered queue
 * is whatever happens to be oldest, which after a few months is entirely
 * resolved.
 */
function queueOrder(status: ContactRequestStatus | undefined) {
  if (status) {
    return OPEN_STATUSES.includes(status)
      ? [asc(contactRequests.createdAt)]
      : [desc(contactRequests.createdAt)];
  }

  return [
    sql`case ${contactRequests.status} when 'new' then 0 when 'in_progress' then 1 when 'resolved' then 2 else 3 end`,
    // Non-null only for the open statuses, so closed rows all tie here and fall
    // through to the newest-first key below.
    sql`case when ${contactRequests.status} in ('new', 'in_progress') then ${contactRequests.createdAt} end asc nulls last`,
    desc(contactRequests.createdAt),
  ];
}

/**
 * The queue, filtered and paged server-side.
 *
 * `total` and `hasMore` describe the filtered set; `counts` does not — see
 * `statusCounts`.
 */
export async function listContactRequests(
  query: ContactRequestQuery,
  actor: AuthenticatedPrincipal,
): Promise<ContactRequestListResponse> {
  const filters = [
    ...(query.status ? [eq(contactRequests.status, query.status)] : []),
    ...(query.mine ? [eq(contactRequests.assignedTo, actor.userId)] : []),
  ];
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, [totals], counts] = await Promise.all([
    selectRecords(db)
      .where(where)
      .orderBy(...queueOrder(query.status))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(contactRequests).where(where),
    statusCounts(),
  ]);

  const total = totals?.total ?? 0;

  return {
    items: rows.map(toRecord),
    total,
    hasMore: query.offset + rows.length < total,
    limit: query.limit,
    offset: query.offset,
    counts,
  };
}

export async function getContactRequest(id: string): Promise<ContactRequestRecord> {
  const [row] = await selectRecords(db).where(eq(contactRequests.id, id)).limit(1);

  if (!row) throw new AppError("not_found", "No such contact request.");
  return toRecord(row);
}

/**
 * Claims, progresses and resolves — all one call, because on a queue screen they
 * are one gesture.
 *
 * The row is taken `FOR UPDATE` and re-read inside the transaction: two
 * coordinators clicking "take it" on the same enquiry would otherwise both write
 * their own name over the other's, and both believe they own it.
 */
export async function updateContactRequest(
  id: string,
  input: UpdateContactRequest,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<ContactRequestRecord> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: contactRequests.id,
        status: contactRequests.status,
        assignedTo: contactRequests.assignedTo,
        firstRespondedAt: contactRequests.firstRespondedAt,
        resolvedAt: contactRequests.resolvedAt,
        resolutionNote: contactRequests.resolutionNote,
      })
      .from(contactRequests)
      .where(eq(contactRequests.id, id))
      .for("update")
      .limit(1);

    if (!current) throw new AppError("not_found", "No such contact request.");

    // Two people working the same screen: the second click is a mistake worth
    // showing rather than a write worth accepting silently.
    if (input.status && input.status === current.status) {
      throw new AppError(
        "conflict",
        `That enquiry is already ${current.status.replace("_", " ")}.`,
      );
    }

    const status = input.status ?? current.status;
    const assignedTo = input.assignToSelf
      ? actor.userId
      : input.unassign
        ? null
        : current.assignedTo;

    const now = new Date();

    /*
     * Stamped the first time the enquiry stops being unattended — someone taking
     * it, or moving it anywhere off `new` — and never rewritten afterwards. It is
     * one half of "how long do people wait"; overwriting it on the second edit
     * would answer that question with the time staff finished instead.
     */
    const firstRespondedAt =
      current.firstRespondedAt ??
      (input.assignToSelf || status !== "new" ? now : null);

    await tx
      .update(contactRequests)
      .set({
        status,
        assignedTo,
        firstRespondedAt,
        // Re-resolving a reopened enquiry moves this to the latest resolution:
        // the date on a closed record should be when it was actually closed.
        resolvedAt: status === "resolved" ? now : current.resolvedAt,
        // An edit with no fresh note keeps the last one rather than wiping what
        // the previous coordinator recorded.
        resolutionNote: input.resolutionNote ?? current.resolutionNote,
      })
      .where(eq(contactRequests.id, id));

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: input.status ? `contact_request.${input.status}` : "contact_request.updated",
      entityType: "contact_requests",
      entityId: id,
      before: {
        status: current.status,
        assignedTo: current.assignedTo,
        firstRespondedAt: current.firstRespondedAt?.toISOString() ?? null,
      },
      after: {
        status,
        assignedTo,
        firstRespondedAt: firstRespondedAt?.toISOString() ?? null,
        // What was written, not the enquiry it answers — the note is the record
        // of the decision, and it is what a later reader needs from this row.
        resolutionNote: input.resolutionNote ?? null,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    const [row] = await selectRecords(tx).where(eq(contactRequests.id, id)).limit(1);
    return toRecord(row!);
  });
}
