import { z } from "zod";

/**
 * Pricing contract — the shapes the admin dashboard writes and the public site
 * reads. Everything is integer cents; the in-home multiplier travels as basis
 * points (10000 = ×1.0) so no float ever carries money.
 *
 * What is deliberately absent: the take-rate, margins, and educator earnings.
 * Those are internal-only (§7) and get their own server-side home when the
 * quote engine ships — nothing here may leak them to a browser bundle.
 */

/**
 * Global sanity band, cents per hour. Rejects the $5,500-instead-of-$55 typo
 * at the Zod edge — an admin who genuinely needs a rate outside $5–$1,000/hr
 * is having a conversation with an engineer, not a form.
 */
export const RATE_SANITY = { minCents: 500, maxCents: 100_000 } as const;

const centsPerHour = z
  .number()
  .int("Amounts are whole cents.")
  .min(RATE_SANITY.minCents, "That's below the platform's $5/hr sanity floor.")
  .max(RATE_SANITY.maxCents, "That's above the platform's $1,000/hr sanity ceiling.");

export const subjectSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
});

// ---------------------------------------------------------------------------
// Rate bands
// ---------------------------------------------------------------------------

export const upsertRateBandSchema = z
  .object({
    subjectSlug: z.string().trim().min(1).max(80),
    minCents: centsPerHour,
    suggestedCents: centsPerHour,
    maxCents: centsPerHour,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minCents > value.suggestedCents) {
      ctx.addIssue({
        code: "custom",
        path: ["suggestedCents"],
        message: "Suggested must be at least the minimum.",
      });
    }
    if (value.suggestedCents > value.maxCents) {
      ctx.addIssue({
        code: "custom",
        path: ["maxCents"],
        message: "Maximum must be at least the suggested rate.",
      });
    }
  });

export type UpsertRateBand = z.infer<typeof upsertRateBandSchema>;

export const rateBandSchema = z.object({
  subjectSlug: z.string(),
  subjectTitle: z.string(),
  minCents: z.number().int(),
  suggestedCents: z.number().int(),
  maxCents: z.number().int(),
  currency: z.string(),
  effectiveFrom: z.iso.datetime(),
});

export type RateBand = z.infer<typeof rateBandSchema>;

// ---------------------------------------------------------------------------
// Educator rates
// ---------------------------------------------------------------------------

export const setEducatorRateSchema = z
  .object({
    educatorSlug: z.string().trim().min(1).max(120),
    subjectSlug: z.string().trim().min(1).max(80),
    rateCents: centsPerHour,
  })
  .strict();

export type SetEducatorRate = z.infer<typeof setEducatorRateSchema>;

/**
 * The admin view of a rate. Two figures, deliberately:
 *
 * `rateCents` is what is stored, and `effectiveRateCents` is what the platform
 * will actually charge — the stored rate clamped into its subject's band. They
 * differ only for a row written before band edits were validated against
 * existing rates, and `outsideBand` is what makes that visible instead of the
 * admin screen quietly disagreeing with the public site.
 */
export const educatorRateSchema = z.object({
  educatorSlug: z.string(),
  educatorName: z.string(),
  subjectSlug: z.string(),
  rateCents: z.number().int(),
  effectiveRateCents: z.number().int(),
  outsideBand: z.boolean(),
  currency: z.string(),
  effectiveFrom: z.iso.datetime(),
});

export type EducatorRateView = z.infer<typeof educatorRateSchema>;

// ---------------------------------------------------------------------------
// Format policy
// ---------------------------------------------------------------------------

export const updateFormatPolicySchema = z
  .object({
    /** 10000 = ×1.0. Capped at ×3 — a bigger differential is a typo. */
    inHomeMultiplierBps: z.number().int().min(10_000).max(30_000),
    travelFlatCents: z.number().int().min(0).max(20_000),
  })
  .strict();

export type UpdateFormatPolicy = z.infer<typeof updateFormatPolicySchema>;

export const formatPolicySchema = z.object({
  inHomeMultiplierBps: z.number().int(),
  travelFlatCents: z.number().int(),
  effectiveFrom: z.iso.datetime(),
});

export type FormatPolicyView = z.infer<typeof formatPolicySchema>;

// ---------------------------------------------------------------------------
// Read views
// ---------------------------------------------------------------------------

/** The admin dashboard's full current-state view. */
export const pricingAdminViewSchema = z.object({
  bands: z.array(rateBandSchema),
  educatorRates: z.array(educatorRateSchema),
  formatPolicy: formatPolicySchema,
});

export type PricingAdminView = z.infer<typeof pricingAdminViewSchema>;

/**
 * The public snapshot the site renders prices from — browse cards, profile
 * pages, the booking estimate. Deliberately an allowlist: rates, bands and the
 * format differential, nothing else. Educator rates are clamped into their
 * subject's band server-side, so a band edit can never break a live page.
 */
export const pricingSnapshotSchema = z.object({
  currency: z.string(),
  inHomeMultiplierBps: z.number().int(),
  travelFlatCents: z.number().int(),
  bands: z.array(
    z.object({
      subjectSlug: z.string(),
      subjectTitle: z.string(),
      minCents: z.number().int(),
      suggestedCents: z.number().int(),
      maxCents: z.number().int(),
    }),
  ),
  educatorRates: z.array(
    z.object({
      educatorSlug: z.string(),
      subjectSlug: z.string(),
      rateCents: z.number().int(),
    }),
  ),
});

export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
