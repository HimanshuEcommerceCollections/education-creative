import { z } from "zod";

/**
 * Site configuration contract (ARCHITECTURE.md §7) — the DB-backed settings
 * store the admin dashboard edits, and the allowlisted slice the public site
 * reads.
 *
 * **What is deliberately absent: values.** This module is imported by the Next
 * app and therefore reachable from a browser bundle, so it carries keys, shapes
 * and validation ranges only. Defaults live in `server/src/config-registry.ts`,
 * next to the service that reads them, because `platform.take_rate_bps` is the
 * platform's cut and §7 says the take-rate never leaves the server — a default
 * compiled into a client chunk leaks it just as surely as an API response would.
 *
 * Ranges *are* here. A ceiling is not the number: "the take rate is at most 50%"
 * tells a reader nothing about what it is, and having the bound on both sides of
 * the wire is what lets the dashboard reject a typo without a round trip.
 */

/**
 * Every setting the store knows about. The union is the gate: an unknown key is
 * refused at the Zod edge on write and ignored on read, so a stale row left by a
 * removed feature can never resurface as behaviour.
 *
 * Prices are absent by design — bands, educator rates and the format
 * differential are effective-dated rows behind `pricing.service.ts`, and a
 * second copy of a rate here would be two sources of truth for a number that
 * appears on a card statement.
 */
export const CONFIG_KEYS = [
  "booking.min_notice_hours",
  "booking.window_months",
  "booking.confirmation_sla_days",
  "booking.cancellation_window_hours",
  "booking.no_show_refund",
  "booking.quote_ttl_minutes",
  "booking.checkout_window_minutes",
  "platform.take_rate_bps",
  "platform.min_margin_cents",
  "platform.expected_stripe_fee_bps",
  "platform.expected_stripe_fee_flat_cents",
  "flags.bookings_enabled",
  "flags.reviews_enabled",
  "flags.educator_applications_open",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const configKeySchema = z.enum(CONFIG_KEYS);

/** Scalars only. Ordered lists (subjects, nav) are relational tables, not KV. */
export const configValueSchema = z.union([z.number(), z.boolean()]);

export type ConfigValue = z.infer<typeof configValueSchema>;

/**
 * How the dashboard renders and parses a value.
 *
 * `money_cents` and `percent_bps` are stored in the integer unit the server
 * computes in and shown in the unit a founder thinks in — dollars and percent.
 * The conversion happens in the Server Action, exactly as the pricing form
 * converts dollars to cents, so no float ever reaches the store.
 */
export const CONFIG_FIELD_KINDS = [
  "integer",
  "boolean",
  "money_cents",
  "percent_bps",
] as const;

export type ConfigFieldKind = (typeof CONFIG_FIELD_KINDS)[number];

// ---------------------------------------------------------------------------
// Admin read view
// ---------------------------------------------------------------------------

/**
 * One setting, as the dashboard receives it.
 *
 * The response carries its own presentation — label, help, unit, bounds, the
 * default — so the editor is data-driven and the browser needs no copy of the
 * registry. That is what keeps the internal defaults server-side while still
 * letting the form say "default: 25%" beside the box.
 */
export const configFieldSchema = z.object({
  key: configKeySchema,
  label: z.string(),
  help: z.string(),
  kind: z.enum(CONFIG_FIELD_KINDS),
  /** Suffix shown after the input ("hours", "days"). Absent for booleans. */
  unit: z.string().optional(),
  /** Inclusive bounds in the stored unit. Absent for booleans. */
  min: z.number().optional(),
  max: z.number().optional(),
  value: configValueSchema,
  /** The registry's default, so reverting is a glance rather than an archaeology. */
  defaultValue: configValueSchema,
  /** False when the value has never been written — it is still the default. */
  overridden: z.boolean(),
  /**
   * False when this role may read the setting but not write it, or when nothing
   * in the platform acts on a change. `lockedReason` says which.
   */
  editable: z.boolean(),
  lockedReason: z.string().optional(),
  updatedAt: z.iso.datetime().nullable(),
  updatedByName: z.string().nullable(),
});

export type ConfigField = z.infer<typeof configFieldSchema>;

export const configGroupSchema = z.object({
  title: z.string(),
  description: z.string(),
  settings: z.array(configFieldSchema),
});

export type ConfigGroup = z.infer<typeof configGroupSchema>;

export const configAdminViewSchema = z.object({
  groups: z.array(configGroupSchema),
  /** True when the caller may write at least one setting on the page. */
  canEditAny: z.boolean(),
});

export type ConfigAdminView = z.infer<typeof configAdminViewSchema>;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A batch write. One group of the form saves together, so a rule expressed
 * across two settings — a take rate and the margin floor it has to clear — is
 * validated against the state it will actually produce rather than against the
 * half of it that happened to be saved first.
 *
 * Per-key range validation happens server-side against the registry: the key
 * union is checkable in a browser, the bounds table is not worth shipping to
 * one, and the server is the only side whose refusal counts anyway.
 */
export const updateConfigSchema = z
  .object({
    settings: z
      .array(
        z
          .object({
            key: configKeySchema,
            value: configValueSchema,
          })
          .strict(),
      )
      .min(1, "Nothing to save.")
      .max(CONFIG_KEYS.length),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const setting of input.settings) {
      if (seen.has(setting.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["settings"],
          message: `${setting.key} appears twice in one save.`,
        });
      }
      seen.add(setting.key);
    }
  });

export type UpdateConfig = z.infer<typeof updateConfigSchema>;

// ---------------------------------------------------------------------------
// Public snapshot
// ---------------------------------------------------------------------------

/**
 * What the public site is allowed to know. An explicit allowlist with named
 * fields, like `pricingSnapshotSchema` — not a map of whatever happens to be in
 * the store, so adding an internal setting can never publish it by accident.
 *
 * Every number here is already shown to parents before they pay: the notice
 * rule greys out slots in the calendar, the SLA and the cancellation window are
 * the promises on the checkout page.
 */
export const configSnapshotSchema = z.object({
  booking: z.object({
    minNoticeHours: z.number().int(),
    windowMonths: z.number().int(),
    confirmationSlaDays: z.number().int(),
    cancellationWindowHours: z.number().int(),
    noShowRefund: z.boolean(),
  }),
  flags: z.object({
    bookingsEnabled: z.boolean(),
    reviewsEnabled: z.boolean(),
    educatorApplicationsOpen: z.boolean(),
  }),
});

export type ConfigSnapshot = z.infer<typeof configSnapshotSchema>;
