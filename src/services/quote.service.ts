import { and, eq, isNull } from "drizzle-orm";

import type { QuoteRequest, QuoteResponse } from "../contracts/bookings.ts";
import { RATE_SANITY } from "../contracts/pricing.ts";
import { FLAG_MESSAGES } from "../constants.ts";
import { db, type DbOrTx } from "../db/client.ts";
import {
  educatorProfiles,
  educatorRates,
  formatPolicies,
  quotes,
  subjectRateBands,
  subjects,
} from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { logger } from "../lib/logger.ts";
import { assertFlagEnabled, getEffectiveConfig } from "./config.service.ts";

/**
 * The pricing engine (ARCHITECTURE.md §7).
 *
 * **Money is computed here and nowhere else.** No endpoint accepts an amount from
 * a client; the browser's figure is an estimate for display and is never sent.
 * Everything below is integer cents, and the in-home multiplier is applied from
 * basis points so no float ever touches a price.
 *
 * Rates, bands and the format differential come from the effective-dated tables
 * behind `pricing.service.ts` — the same rows the public snapshot renders from.
 * There is deliberately no second copy of a price in this file.
 *
 * One duration basis: the same `durationHours` drives the parent's charge and the
 * educator's earnings. A separate "length multiplier" for billing is how a pricing model
 * ends up with negative margins on long sessions.
 */

const PLATFORM_CURRENCY = "USD";

export interface ResolvedQuote extends QuoteResponse {
  educatorProfileId: string;
  subjectId: string;
  subjectTopic: string;
  format: QuoteRequest["format"];
  durationMinutes: number;
  effectiveRatePerHourCents: number;
  takeRateBps: number;
  educatorEarningsCents: number;
  platformMarginCents: number;
  expectedFeeCents: number;
}

/**
 * Resolves the hourly rate for (educator, subject) at quote time.
 *
 * Order matters and mirrors §7: the educator's own rate if they have one, else the
 * subject's suggested rate. Whichever wins is then **clamped into the band**, so a
 * band an admin narrowed after a rate was set can never produce a charge outside
 * the platform's own published rules. Clamping is logged, because a rate that
 * needs clamping is a data problem someone should fix.
 */
async function resolveRate(
  dbOrTx: DbOrTx,
  educatorProfileId: string,
  subjectId: string,
): Promise<number> {
  const [band] = await dbOrTx
    .select({
      minCents: subjectRateBands.minCents,
      suggestedCents: subjectRateBands.suggestedCents,
      maxCents: subjectRateBands.maxCents,
    })
    .from(subjectRateBands)
    .where(
      and(eq(subjectRateBands.subjectId, subjectId), isNull(subjectRateBands.effectiveTo)),
    )
    .limit(1);

  if (!band) {
    // No band means nobody has priced this subject. Refusing is the only safe
    // answer — inventing a rate here is how a $0 or a $10,000 booking happens.
    throw new AppError(
      "conflict",
      "We can't price that subject right now. Please choose another, or contact us.",
      { logContext: { subjectId, reason: "no_rate_band_in_force" } },
    );
  }

  const [own] = await dbOrTx
    .select({ rateCents: educatorRates.rateCents })
    .from(educatorRates)
    .where(
      and(
        eq(educatorRates.educatorProfileId, educatorProfileId),
        eq(educatorRates.subjectId, subjectId),
        isNull(educatorRates.effectiveTo),
      ),
    )
    .limit(1);

  const requested = own?.rateCents ?? band.suggestedCents;
  const clamped = Math.min(Math.max(requested, band.minCents), band.maxCents);

  if (clamped !== requested) {
    logger.warn(
      { educatorProfileId, subjectId, requested, clamped },
      "educator rate outside its subject band — pricing at the clamped figure",
    );
  }

  /*
   * The global sanity band, on top of the subject band. Belt and braces: a band
   * itself could have been saved wrong, and this is the guard that rejects the
   * $5,500-instead-of-$55 typo no matter which table it got into.
   */
  if (clamped < RATE_SANITY.minCents || clamped > RATE_SANITY.maxCents) {
    throw new AppError("conflict", "We can't price that session right now.", {
      logContext: {
        educatorProfileId,
        subjectId,
        clamped,
        reason: "rate_outside_sanity_band",
      },
    });
  }

  return clamped;
}

/** The in-home differential in force, or the identity when none is configured. */
async function resolveFormatPolicy(dbOrTx: DbOrTx) {
  const [row] = await dbOrTx
    .select({
      inHomeMultiplierBps: formatPolicies.inHomeMultiplierBps,
      travelFlatCents: formatPolicies.travelFlatCents,
    })
    .from(formatPolicies)
    .where(isNull(formatPolicies.effectiveTo))
    .limit(1);

  return row ?? { inHomeMultiplierBps: 10_000, travelFlatCents: 0 };
}

/**
 * Prices a session without persisting anything. Used by `POST /quotes` and by
 * booking creation, so the two can never disagree about what a session costs.
 */
export async function priceSession(
  dbOrTx: DbOrTx,
  input: {
    educatorProfileId: string;
    subjectId: string;
    subjectTopic: string;
    format: QuoteRequest["format"];
    durationMinutes: number;
  },
): Promise<Omit<ResolvedQuote, "id" | "expiresAt">> {
  const [ratePerHourCents, policy, config] = await Promise.all([
    resolveRate(dbOrTx, input.educatorProfileId, input.subjectId),
    resolveFormatPolicy(dbOrTx),
    getEffectiveConfig(),
  ]);

  const durationHours = input.durationMinutes / 60;
  const baseCents = Math.round(ratePerHourCents * durationHours);

  const lineItems: { label: string; amountCents: number }[] = [
    {
      label: `${input.durationMinutes} min at $${(ratePerHourCents / 100).toFixed(0)}/hr`,
      amountCents: baseCents,
    },
  ];

  let totalCents = baseCents;

  if (input.format === "in_home") {
    const adjustedCents = Math.round((baseCents * policy.inHomeMultiplierBps) / 10_000);
    const differenceCents = adjustedCents - baseCents;

    // Each line is added only when it carries a number worth reading, so a
    // receipt with no differential configured doesn't show two "+$0" rows.
    if (differenceCents !== 0) {
      lineItems.push({ label: "In-home session", amountCents: differenceCents });
    }
    if (policy.travelFlatCents !== 0) {
      lineItems.push({ label: "Travel", amountCents: policy.travelFlatCents });
    }

    totalCents = adjustedCents + policy.travelFlatCents;
  }

  /*
   * The internal split. Never serialised to a parent — the DTO returned by the
   * routes drops these, and `quoteResponseSchema` has no field for them.
   *
   * Because the take is a slice of the same gross, `educatorEarnings ≤ total`
   * holds by construction. There is no arithmetic here that can pay an educator
   * more than the platform collected.
   *
   * The take rate is read live from site configuration and **frozen onto the
   * quote row below**, so an admin editing it never re-prices a quote already
   * issued — the stored figure is what reconciliation and any later replay use.
   */
  const takeCents = Math.round((totalCents * config.platform.takeRateBps) / 10_000);
  const educatorEarningsCents = totalCents - takeCents;
  const expectedFeeCents =
    Math.round((totalCents * config.platform.expectedStripeFeeBps) / 10_000) +
    config.platform.expectedStripeFeeFlatCents;
  const platformMarginCents = totalCents - educatorEarningsCents - expectedFeeCents;

  /*
   * Fail closed. A session that loses money is not priced and not sold — not
   * flagged for review and sold anyway, which is the version of this rule that
   * quietly bleeds a marketplace.
   */
  if (platformMarginCents < config.platform.minMarginCents) {
    throw new AppError(
      "conflict",
      "We can't take this booking online right now. Please contact us and we'll arrange it.",
      {
        logContext: {
          educatorProfileId: input.educatorProfileId,
          subjectId: input.subjectId,
          totalCents,
          educatorEarningsCents,
          expectedFeeCents,
          platformMarginCents,
          reason: "margin_below_floor",
        },
      },
    );
  }

  return {
    educatorProfileId: input.educatorProfileId,
    subjectId: input.subjectId,
    subjectTopic: input.subjectTopic,
    format: input.format,
    durationMinutes: input.durationMinutes,
    currency: PLATFORM_CURRENCY,
    lineItems,
    totalCents,
    effectiveRatePerHourCents: ratePerHourCents,
    takeRateBps: config.platform.takeRateBps,
    educatorEarningsCents,
    platformMarginCents,
    expectedFeeCents,
  };
}

/** Resolves an educator slug to a live profile, or 404s. */
export async function requireEducator(dbOrTx: DbOrTx, slug: string) {
  const [educator] = await dbOrTx
    .select({
      id: educatorProfiles.id,
      name: educatorProfiles.name,
      slug: educatorProfiles.slug,
      subjects: educatorProfiles.subjects,
      verificationStatus: educatorProfiles.verificationStatus,
    })
    .from(educatorProfiles)
    .where(and(eq(educatorProfiles.slug, slug), isNull(educatorProfiles.deletedAt)))
    .limit(1);

  if (!educator) {
    throw new AppError("not_found", "We couldn't find that educator.");
  }
  return educator;
}

/** Resolves a subject slug to its id, or 404s. */
export async function requireSubject(dbOrTx: DbOrTx, slug: string) {
  const [subject] = await dbOrTx
    .select({ id: subjects.id, slug: subjects.slug, title: subjects.title })
    .from(subjects)
    .where(and(eq(subjects.slug, slug), eq(subjects.isActive, true)))
    .limit(1);

  if (!subject) {
    throw new AppError("not_found", "We couldn't find that subject.");
  }
  return subject;
}

/**
 * Rejects a topic the educator doesn't list.
 *
 * This is what stops a hand-crafted request booking "Astrophysics" with an arts
 * teacher, so an empty list is refused rather than waved through: it means nobody
 * has recorded what this educator teaches, and skipping the check for exactly
 * those profiles would turn the guard off for the least-vetted ones. Every
 * profile can be filled in through the educator endpoints, so an empty list is a
 * profile to finish, not a state to price against.
 */
export function assertTeachesTopic(
  educator: { subjects: string[]; name: string },
  topic: string,
): void {
  if (educator.subjects.length === 0) {
    throw new AppError(
      "conflict",
      `We can't take a booking for ${educator.name} yet — their subjects aren't set up.`,
      { fieldErrors: { subjectTopic: "Choose another educator for now." } },
    );
  }
  if (educator.subjects.includes(topic)) return;

  throw new AppError("validation_failed", `${educator.name} doesn't teach that.`, {
    fieldErrors: { subjectTopic: "Choose one of this educator's subjects." },
  });
}

/**
 * Issues a quote and stores it.
 *
 * The stored row is what booking creation re-validates against, which is the
 * point: the amount charged is derived from a row this server wrote, not from
 * anything the browser held in the meantime.
 */
export async function createQuote(
  customerProfileId: string,
  input: QuoteRequest,
): Promise<QuoteResponse> {
  await assertFlagEnabled("bookingsEnabled", FLAG_MESSAGES.bookingsPaused);

  const educator = await requireEducator(db, input.educatorSlug);
  const subject = await requireSubject(db, input.subjectSlug);
  assertTeachesTopic(educator, input.subjectTopic);

  const priced = await priceSession(db, {
    educatorProfileId: educator.id,
    subjectId: subject.id,
    subjectTopic: input.subjectTopic,
    format: input.format,
    durationMinutes: input.durationMinutes,
  });

  const { booking } = await getEffectiveConfig();
  const expiresAt = new Date(Date.now() + booking.quoteTtlMinutes * 60_000);

  const [row] = await db
    .insert(quotes)
    .values({
      customerProfileId,
      educatorProfileId: priced.educatorProfileId,
      subjectId: priced.subjectId,
      subjectTopic: priced.subjectTopic,
      format: priced.format,
      durationMinutes: priced.durationMinutes,
      currency: priced.currency,
      lineItems: priced.lineItems,
      totalCents: priced.totalCents,
      effectiveRatePerHourCents: priced.effectiveRatePerHourCents,
      takeRateBps: priced.takeRateBps,
      educatorEarningsCents: priced.educatorEarningsCents,
      platformMarginCents: priced.platformMarginCents,
      expectedFeeCents: priced.expectedFeeCents,
      expiresAt,
    })
    .returning({ id: quotes.id });

  // Only the parent-facing fields. The split stays server-side.
  return {
    id: row!.id,
    currency: priced.currency,
    lineItems: priced.lineItems,
    totalCents: priced.totalCents,
    expiresAt: expiresAt.toISOString(),
  };
}
