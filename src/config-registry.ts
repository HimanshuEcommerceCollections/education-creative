import type { ConfigFieldKind, ConfigKey, ConfigValue } from "./contracts/config.ts";
import { CONFIG_KEYS } from "./contracts/config.ts";
import { BOOKING_POLICY } from "./constants.ts";

/**
 * The site-configuration registry (ARCHITECTURE.md §7) — one entry per setting,
 * carrying its default, its bounds, who may write it, and the copy the dashboard
 * renders.
 *
 * **Server-side on purpose.** The keys and shapes live in `contracts/config.ts`
 * because the Next app validates against them; the *values* live here because
 * `platform.take_rate_bps` is the platform's cut and §7 keeps it off the wire to
 * a browser. The admin API sends a default down only to callers who already have
 * permission to read the setting.
 *
 * Defaults are `BOOKING_POLICY` — the launch constants — rather than a second
 * set of numbers. That is what makes an empty `config_settings` table behave
 * exactly like the code did before the store existed, and it means "reset to
 * default" and "what shipped" are the same answer.
 */

/** Who may write a setting. `staff` includes coordinators; `admin` does not. */
export type ConfigEditorRole = "admin" | "staff";

export interface ConfigSettingDefinition {
  key: ConfigKey;
  /** Card the setting appears under, and the unit a save batches by. */
  group: ConfigGroupKey;
  label: string;
  help: string;
  kind: ConfigFieldKind;
  unit?: string;
  /** Inclusive bounds in the stored unit. Omitted for booleans. */
  min?: number;
  max?: number;
  defaultValue: ConfigValue;
  /**
   * `null` when nothing in the platform acts on a change — the setting is shown
   * as the stated policy and refused on write, with `lockedReason` saying why.
   * A switch that flips and changes nothing is worse than no switch.
   */
  editableBy: ConfigEditorRole | null;
  lockedReason?: string;
  /** Included in the public snapshot the site renders from. */
  publicField: boolean;
}

export const CONFIG_GROUP_KEYS = [
  "booking_window",
  "checkout",
  "refunds",
  "economics",
  "flags",
] as const;

export type ConfigGroupKey = (typeof CONFIG_GROUP_KEYS)[number];

export const CONFIG_GROUPS: Record<
  ConfigGroupKey,
  { title: string; description: string }
> = {
  booking_window: {
    title: "Booking window",
    description:
      "How far ahead a parent may book, and how little notice a coordinator can work with. The booking calendar greys out slots against the same numbers, so these are the rule and the courtesy at once.",
  },
  checkout: {
    title: "Checkout & confirmation",
    description:
      "How long a price is held, how long a Stripe checkout stays payable, and how long a coordinator has to confirm before an unconfirmed booking auto-refunds in full.",
  },
  refunds: {
    title: "Refund policy",
    description:
      "The promise made on the checkout page. A parent reads these before they pay, so changing them changes what was promised to everyone who books afterwards — not to anyone who already has.",
  },
  economics: {
    title: "Platform economics",
    description:
      "The platform's cut and the floor a booking's margin must clear. Internal — never sent to a browser, never shown to an educator. Live quotes freeze the take rate they were priced at, so a change here moves new quotes only.",
  },
  flags: {
    title: "Feature switches",
    description:
      "Kill switches for the public entry points. Turning one off closes that door politely — the page still renders and explains itself; it just stops accepting.",
  },
};

/**
 * Every setting, in the order the dashboard shows them.
 *
 * Bounds are the honest ones, not round numbers: `checkout_window_minutes` is
 * 30–1440 because that is the range Stripe accepts for a Checkout Session's
 * `expires_at`, and a value outside it fails at Stripe rather than here.
 */
export const CONFIG_SETTINGS: readonly ConfigSettingDefinition[] = [
  {
    key: "booking.min_notice_hours",
    group: "booking_window",
    label: "Minimum notice",
    help: "A coordinator has to read the request, reach the educator by phone and confirm. A session starting inside this window is refused rather than charged for.",
    kind: "integer",
    unit: "hours",
    min: 1,
    max: 168,
    defaultValue: BOOKING_POLICY.minNoticeHours,
    editableBy: "staff",
    publicField: true,
  },
  {
    key: "booking.window_months",
    group: "booking_window",
    label: "Booking window",
    help: "How far ahead a session may be requested, in whole calendar months — the window runs to the end of the month this many months after the current one.",
    kind: "integer",
    unit: "months",
    min: 1,
    max: 12,
    defaultValue: BOOKING_POLICY.bookingWindowMonths,
    editableBy: "staff",
    publicField: true,
  },
  {
    key: "booking.quote_ttl_minutes",
    group: "checkout",
    label: "Quote lifetime",
    help: "How long a quoted price is held. Short on purpose, so a price can't be carried across a rate change and paid at yesterday's figure.",
    kind: "integer",
    unit: "minutes",
    min: 5,
    max: 120,
    defaultValue: BOOKING_POLICY.quoteTtlMinutes,
    editableBy: "staff",
    publicField: false,
  },
  {
    key: "booking.checkout_window_minutes",
    group: "checkout",
    label: "Checkout window",
    help: "How long a Stripe checkout stays payable. Stripe enforces this and accepts 30 minutes to 24 hours — the payment page reads the expiry off the session rather than estimating it.",
    kind: "integer",
    unit: "minutes",
    min: 30,
    max: 1440,
    defaultValue: BOOKING_POLICY.checkoutWindowMinutes,
    editableBy: "staff",
    publicField: false,
  },
  {
    key: "booking.confirmation_sla_days",
    group: "checkout",
    label: "Confirmation SLA",
    help: "How long a coordinator has to confirm a paid booking before it auto-refunds in full. Shown to the parent before they pay, so raising it lengthens a promise already made on the checkout page.",
    kind: "integer",
    unit: "days",
    min: 1,
    max: 14,
    defaultValue: BOOKING_POLICY.confirmationSlaDays,
    editableBy: "staff",
    publicField: true,
  },
  {
    key: "booking.cancellation_window_hours",
    group: "refunds",
    label: "Free cancellation window",
    help: "A parent cancelling at least this far ahead is refunded in full; inside it, a person looks at the request. Money rule — admin only.",
    kind: "integer",
    unit: "hours",
    min: 0,
    max: 336,
    defaultValue: BOOKING_POLICY.cancellationWindowHours,
    editableBy: "admin",
    publicField: true,
  },
  {
    key: "booking.no_show_refund",
    group: "refunds",
    label: "Refund a no-show",
    help: "A session nobody turned up to is not refunded.",
    kind: "boolean",
    defaultValue: BOOKING_POLICY.noShowRefund,
    editableBy: null,
    lockedReason:
      "Turning this on would need an automatic refund on the no-show path, and no such path exists — a switch that flips and refunds nobody is worse than no switch. Refund a specific no-show from the booking itself.",
    publicField: true,
  },
  {
    key: "platform.take_rate_bps",
    group: "economics",
    label: "Platform take rate",
    help: "The platform's slice of each booking's gross. The educator's share is the remainder of the same gross, so it can never exceed what was collected.",
    kind: "percent_bps",
    min: 0,
    max: 5000,
    defaultValue: BOOKING_POLICY.takeRateBps,
    editableBy: "admin",
    publicField: false,
  },
  {
    key: "platform.min_margin_cents",
    group: "economics",
    label: "Margin floor",
    help: "A booking whose platform margin falls below this is refused rather than sold. Fail-closed: a session that loses money is not priced.",
    kind: "money_cents",
    min: 0,
    max: 20_000,
    defaultValue: BOOKING_POLICY.minMarginCents,
    editableBy: "admin",
    publicField: false,
  },
  {
    key: "platform.expected_stripe_fee_bps",
    group: "economics",
    label: "Expected Stripe fee (percentage)",
    help: "An estimate, used only by the margin guard. Real fees arrive on the balance transaction and replace it — nothing is accounted for from this number.",
    kind: "percent_bps",
    min: 0,
    max: 1000,
    defaultValue: BOOKING_POLICY.expectedStripeFeeBps,
    editableBy: "admin",
    publicField: false,
  },
  {
    key: "platform.expected_stripe_fee_flat_cents",
    group: "economics",
    label: "Expected Stripe fee (fixed)",
    help: "The per-transaction part of the same estimate.",
    kind: "money_cents",
    min: 0,
    max: 500,
    defaultValue: BOOKING_POLICY.expectedStripeFeeFlatCents,
    editableBy: "admin",
    publicField: false,
  },
  {
    key: "flags.bookings_enabled",
    group: "flags",
    label: "Accept new bookings",
    help: "Off stops new quotes and new bookings platform-wide. Bookings already paid for are untouched — coordinators keep confirming, refunding and rescheduling them.",
    kind: "boolean",
    defaultValue: true,
    editableBy: "admin",
    publicField: true,
  },
  {
    key: "flags.reviews_enabled",
    group: "flags",
    label: "Accept new reviews",
    help: "Off stops parents submitting reviews. Published reviews stay up, and the moderation queue keeps working.",
    kind: "boolean",
    defaultValue: true,
    editableBy: "admin",
    publicField: true,
  },
  {
    key: "flags.educator_applications_open",
    group: "flags",
    label: "Educator applications open",
    help: "Off stops the public application form accepting. Applications already in the queue are reviewed as normal.",
    kind: "boolean",
    defaultValue: true,
    editableBy: "admin",
    publicField: true,
  },
];

export const CONFIG_BY_KEY: ReadonlyMap<ConfigKey, ConfigSettingDefinition> = new Map(
  CONFIG_SETTINGS.map((setting) => [setting.key, setting]),
);

/*
 * A key in the contract with no definition here would be readable, unwritable
 * and invisible on the dashboard — a setting that exists only as a type. Caught
 * at import rather than by whoever eventually notices the gap.
 */
for (const key of CONFIG_KEYS) {
  if (!CONFIG_BY_KEY.has(key)) {
    throw new Error(`config-registry.ts is missing a definition for "${key}".`);
  }
}

/** The defaults, as the store's starting state. */
export const CONFIG_DEFAULTS: Readonly<Record<ConfigKey, ConfigValue>> =
  Object.freeze(
    Object.fromEntries(
      CONFIG_SETTINGS.map((setting) => [setting.key, setting.defaultValue]),
    ) as Record<ConfigKey, ConfigValue>,
  );

/**
 * Validates a value against its definition — the same check whether it arrives
 * from the dashboard or is read back off a row written before a bound changed.
 *
 * Returns a message rather than throwing, because both callers want to say which
 * setting was wrong alongside the others they are processing.
 */
export function validateConfigValue(
  definition: ConfigSettingDefinition,
  value: ConfigValue,
): string | null {
  if (definition.kind === "boolean") {
    return typeof value === "boolean" ? null : "Expected a yes/no value.";
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "Expected a whole number.";
  }
  if (definition.min !== undefined && value < definition.min) {
    return `Minimum is ${describeBound(definition, definition.min)}.`;
  }
  if (definition.max !== undefined && value > definition.max) {
    return `Maximum is ${describeBound(definition, definition.max)}.`;
  }
  return null;
}

/** A bound in the unit the admin typed it in, so the message matches the box. */
function describeBound(definition: ConfigSettingDefinition, bound: number): string {
  if (definition.kind === "percent_bps") return `${bound / 100}%`;
  if (definition.kind === "money_cents") return `$${(bound / 100).toFixed(2)}`;
  return definition.unit ? `${bound} ${definition.unit}` : String(bound);
}
