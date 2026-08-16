import { and, asc, eq, gt, isNull, lt, or, sql as rawSql } from "drizzle-orm";

import type {
  PricingAdminView,
  PricingSnapshot,
  SetEducatorRate,
  UpdateFormatPolicy,
  UpsertRateBand,
} from "../contracts/pricing.ts";
import { db, type DbOrTx } from "../db/client.ts";
import {
  educatorProfiles,
  educatorRates,
  formatPolicies,
  subjectRateBands,
  subjects,
} from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { logger } from "../lib/logger.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/**
 * Pricing rules (§7). All three rule tables are effective-dated and
 * append-only: every write here closes the row in force and inserts its
 * replacement in one transaction, with an audit row alongside. Nothing is ever
 * updated in place, so "what was the price on the 3rd?" is always answerable.
 */

const PLATFORM_CURRENCY = "USD";

/** The row currently in force — `effective_to` still open. */
const current = { effectiveTo: isNull(subjectRateBands.effectiveTo) };

async function currentFormatPolicy(dbOrTx: DbOrTx) {
  const [row] = await dbOrTx
    .select()
    .from(formatPolicies)
    .where(isNull(formatPolicies.effectiveTo))
    .limit(1);
  return row ?? null;
}

async function currentBands(dbOrTx: DbOrTx) {
  return dbOrTx
    .select({
      subjectId: subjects.id,
      subjectSlug: subjects.slug,
      subjectTitle: subjects.title,
      minCents: subjectRateBands.minCents,
      suggestedCents: subjectRateBands.suggestedCents,
      maxCents: subjectRateBands.maxCents,
      currency: subjectRateBands.currency,
      effectiveFrom: subjectRateBands.effectiveFrom,
    })
    .from(subjectRateBands)
    .innerJoin(subjects, eq(subjectRateBands.subjectId, subjects.id))
    .where(and(current.effectiveTo, eq(subjects.isActive, true)))
    .orderBy(asc(subjects.sortOrder));
}

async function currentRates(dbOrTx: DbOrTx) {
  return dbOrTx
    .select({
      educatorProfileId: educatorRates.educatorProfileId,
      educatorSlug: educatorProfiles.slug,
      educatorName: educatorProfiles.name,
      subjectId: educatorRates.subjectId,
      subjectSlug: subjects.slug,
      rateCents: educatorRates.rateCents,
      currency: educatorRates.currency,
      effectiveFrom: educatorRates.effectiveFrom,
    })
    .from(educatorRates)
    .innerJoin(
      educatorProfiles,
      eq(educatorRates.educatorProfileId, educatorProfiles.id),
    )
    .innerJoin(subjects, eq(educatorRates.subjectId, subjects.id))
    .where(and(isNull(educatorRates.effectiveTo), isNull(educatorProfiles.deletedAt)))
    .orderBy(asc(educatorProfiles.name));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Pairs each in-force rate with the figure the platform will actually use: the
 * stored rate clamped into its subject's band, which is the same arithmetic the
 * quote engine applies.
 *
 * **Both reads go through this**, so the admin screen and the public site can never
 * disagree about an educator's price. Clamped separately, the admin is the one left
 * showing a number no page would ever charge. `upsertRateBand` refuses a band that
 * would need clamping, so `outsideBand` should only ever be true for rows that predate
 * that check; it is logged for exactly that reason.
 */
function withEffectiveRates(
  bands: Awaited<ReturnType<typeof currentBands>>,
  rates: Awaited<ReturnType<typeof currentRates>>,
) {
  const bandBySubject = new Map(bands.map((band) => [band.subjectSlug, band]));

  return rates.map((rate) => {
    const band = bandBySubject.get(rate.subjectSlug);
    const effectiveRateCents = band
      ? Math.min(Math.max(rate.rateCents, band.minCents), band.maxCents)
      : rate.rateCents;
    const outsideBand = effectiveRateCents !== rate.rateCents;

    if (outsideBand) {
      logger.warn(
        { educator: rate.educatorSlug, subject: rate.subjectSlug, effectiveRateCents },
        "educator rate outside its subject band — serving the clamped figure",
      );
    }

    return { ...rate, effectiveRateCents, outsideBand };
  });
}

/**
 * The public snapshot every price on the site renders from. Allowlisted — no
 * take-rate, no margin, no history. Rates are the **effective** figures, so a
 * band that no longer contains a stored rate can't put a number outside the
 * platform's own rules on a live page.
 */
export async function getPricingSnapshot(): Promise<PricingSnapshot> {
  const [bands, rates, policy] = await Promise.all([
    currentBands(db),
    currentRates(db),
    currentFormatPolicy(db),
  ]);

  const effectiveRates = withEffectiveRates(bands, rates);

  return {
    currency: PLATFORM_CURRENCY,
    inHomeMultiplierBps: policy?.inHomeMultiplierBps ?? 10_000,
    travelFlatCents: policy?.travelFlatCents ?? 0,
    bands: bands.map((band) => ({
      subjectSlug: band.subjectSlug,
      subjectTitle: band.subjectTitle,
      minCents: band.minCents,
      suggestedCents: band.suggestedCents,
      maxCents: band.maxCents,
    })),
    educatorRates: effectiveRates.map((rate) => ({
      educatorSlug: rate.educatorSlug,
      subjectSlug: rate.subjectSlug,
      rateCents: rate.effectiveRateCents,
    })),
  };
}

/**
 * The admin dashboard's current-state view — the same rows with names, carrying
 * both the stored rate and the effective one so a drift between them is visible
 * on the screen that can fix it.
 */
export async function getPricingAdminView(): Promise<PricingAdminView> {
  const [bands, rates, policy] = await Promise.all([
    currentBands(db),
    currentRates(db),
    currentFormatPolicy(db),
  ]);

  const effectiveRates = withEffectiveRates(bands, rates);

  return {
    bands: bands.map((band) => ({
      subjectSlug: band.subjectSlug,
      subjectTitle: band.subjectTitle,
      minCents: band.minCents,
      suggestedCents: band.suggestedCents,
      maxCents: band.maxCents,
      currency: band.currency,
      effectiveFrom: band.effectiveFrom.toISOString(),
    })),
    educatorRates: effectiveRates.map((rate) => ({
      educatorSlug: rate.educatorSlug,
      educatorName: rate.educatorName,
      subjectSlug: rate.subjectSlug,
      rateCents: rate.rateCents,
      effectiveRateCents: rate.effectiveRateCents,
      outsideBand: rate.outsideBand,
      currency: rate.currency,
      effectiveFrom: rate.effectiveFrom.toISOString(),
    })),
    formatPolicy: {
      inHomeMultiplierBps: policy?.inHomeMultiplierBps ?? 10_000,
      travelFlatCents: policy?.travelFlatCents ?? 0,
      effectiveFrom: (policy?.effectiveFrom ?? new Date(0)).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Writes — admin-only at the route, audited here
// ---------------------------------------------------------------------------

async function requireSubject(slug: string) {
  const [subject] = await db
    .select({ id: subjects.id, slug: subjects.slug })
    .from(subjects)
    .where(eq(subjects.slug, slug))
    .limit(1);
  if (!subject) throw new AppError("not_found", "No such subject.");
  return subject;
}

/**
 * Sets a subject's band: closes the row in force, inserts the new version.
 *
 * Refuses a band that wouldn't contain a rate already in force. Allowed through, such a
 * narrowing is silent — every affected educator's public price drops to the new ceiling
 * at read time with only a log line to say so — and a money edit that re-prices people
 * who weren't named in it is exactly the kind that has to fail loudly rather than be
 * reported into the void.
 */
export async function upsertRateBand(
  input: UpsertRateBand,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<void> {
  const subject = await requireSubject(input.subjectSlug);

  await db.transaction(async (tx) => {
    await assertBandContainsExistingRates(tx, subject.id, input);

    const [previous] = await tx
      .update(subjectRateBands)
      .set({ effectiveTo: new Date() })
      .where(
        and(
          eq(subjectRateBands.subjectId, subject.id),
          isNull(subjectRateBands.effectiveTo),
        ),
      )
      .returning({
        minCents: subjectRateBands.minCents,
        suggestedCents: subjectRateBands.suggestedCents,
        maxCents: subjectRateBands.maxCents,
      });

    await tx.insert(subjectRateBands).values({
      subjectId: subject.id,
      minCents: input.minCents,
      suggestedCents: input.suggestedCents,
      maxCents: input.maxCents,
      createdBy: actor.userId,
    });

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "pricing.band_updated",
      entityType: "subject_rate_bands",
      entityId: subject.id,
      before: previous ?? null,
      after: {
        minCents: input.minCents,
        suggestedCents: input.suggestedCents,
        maxCents: input.maxCents,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });
}

/**
 * The in-force rates a proposed band would leave stranded.
 *
 * Run inside the caller's transaction, so a rate being set at the same moment
 * either lands before this reads it or waits behind the band's own write.
 */
async function assertBandContainsExistingRates(
  tx: DbOrTx,
  subjectId: string,
  input: UpsertRateBand,
): Promise<void> {
  const stranded = await tx
    .select({
      educatorName: educatorProfiles.name,
      educatorSlug: educatorProfiles.slug,
      rateCents: educatorRates.rateCents,
    })
    .from(educatorRates)
    .innerJoin(educatorProfiles, eq(educatorRates.educatorProfileId, educatorProfiles.id))
    .where(
      and(
        eq(educatorRates.subjectId, subjectId),
        isNull(educatorRates.effectiveTo),
        isNull(educatorProfiles.deletedAt),
        or(
          lt(educatorRates.rateCents, input.minCents),
          gt(educatorRates.rateCents, input.maxCents),
        ),
      ),
    )
    .orderBy(asc(educatorProfiles.name));

  if (stranded.length === 0) return;

  const named = stranded
    .slice(0, 3)
    .map((rate) => `${rate.educatorName} ($${rate.rateCents / 100}/hr)`)
    .join(", ");
  const rest = stranded.length > 3 ? ` and ${stranded.length - 3} more` : "";

  const fieldErrors: Record<string, string> = {};
  if (stranded.some((rate) => rate.rateCents < input.minCents)) {
    fieldErrors.minCents = "Above a rate already in force.";
  }
  if (stranded.some((rate) => rate.rateCents > input.maxCents)) {
    fieldErrors.maxCents = "Below a rate already in force.";
  }

  throw new AppError(
    "validation_failed",
    `That band would leave ${stranded.length} rate(s) outside it — ${named}${rest}. ` +
      "Move those rates first; a band edit must not re-price an educator silently.",
    { fieldErrors },
  );
}

/**
 * Sets an educator's hourly rate for a subject, validated against the band in
 * force — the write refuses out-of-band rather than clamping, because unlike a
 * live page render, an admin mid-edit can simply be told.
 */
export async function setEducatorRate(
  input: SetEducatorRate,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<void> {
  const subject = await requireSubject(input.subjectSlug);

  const [educator] = await db
    .select({ id: educatorProfiles.id, slug: educatorProfiles.slug })
    .from(educatorProfiles)
    .where(
      and(eq(educatorProfiles.slug, input.educatorSlug), isNull(educatorProfiles.deletedAt)),
    )
    .limit(1);
  if (!educator) throw new AppError("not_found", "No such educator.");

  const [band] = await db
    .select({
      minCents: subjectRateBands.minCents,
      maxCents: subjectRateBands.maxCents,
    })
    .from(subjectRateBands)
    .where(
      and(eq(subjectRateBands.subjectId, subject.id), isNull(subjectRateBands.effectiveTo)),
    )
    .limit(1);

  if (band && (input.rateCents < band.minCents || input.rateCents > band.maxCents)) {
    throw new AppError(
      "validation_failed",
      `That rate is outside the ${input.subjectSlug} band ` +
        `($${band.minCents / 100}–$${band.maxCents / 100}/hr). Adjust the band first ` +
        "if the rate is right.",
      { fieldErrors: { rateCents: "Outside the subject's rate band." } },
    );
  }

  await db.transaction(async (tx) => {
    const [previous] = await tx
      .update(educatorRates)
      .set({ effectiveTo: new Date() })
      .where(
        and(
          eq(educatorRates.educatorProfileId, educator.id),
          eq(educatorRates.subjectId, subject.id),
          isNull(educatorRates.effectiveTo),
        ),
      )
      .returning({ rateCents: educatorRates.rateCents });

    await tx.insert(educatorRates).values({
      educatorProfileId: educator.id,
      subjectId: subject.id,
      rateCents: input.rateCents,
      createdBy: actor.userId,
    });

    /*
     * Keeps the browse grid's cached "from" figure honest without a join.
     * Recomputed across every rate this educator has in force, not set to the one
     * just edited — assigning the latest edit made a multi-subject educator's
     * public "from" price whichever subject was saved most recently, which is not
     * a minimum and is visibly wrong to anyone reading the card.
     */
    const [lowest] = await tx
      .select({ rateCents: rawSql<number | null>`min(${educatorRates.rateCents})` })
      .from(educatorRates)
      .where(
        and(
          eq(educatorRates.educatorProfileId, educator.id),
          isNull(educatorRates.effectiveTo),
        ),
      );

    await tx
      .update(educatorProfiles)
      .set({ minRateCents: lowest?.rateCents ?? input.rateCents })
      .where(eq(educatorProfiles.id, educator.id));

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "pricing.educator_rate_updated",
      entityType: "educator_rates",
      entityId: educator.id,
      before: previous ?? null,
      after: { subjectSlug: subject.slug, rateCents: input.rateCents },
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });
}

/** Sets the in-home differential. Same close-and-insert pattern. */
export async function updateFormatPolicy(
  input: UpdateFormatPolicy,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [previous] = await tx
      .update(formatPolicies)
      .set({ effectiveTo: new Date() })
      .where(isNull(formatPolicies.effectiveTo))
      .returning({
        inHomeMultiplierBps: formatPolicies.inHomeMultiplierBps,
        travelFlatCents: formatPolicies.travelFlatCents,
      });

    await tx.insert(formatPolicies).values({
      inHomeMultiplierBps: input.inHomeMultiplierBps,
      travelFlatCents: input.travelFlatCents,
      createdBy: actor.userId,
    });

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "pricing.format_policy_updated",
      entityType: "format_policies",
      entityId: null,
      before: previous ?? null,
      after: input,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });
}
