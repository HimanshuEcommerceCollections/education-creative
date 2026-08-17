import { eq, inArray } from "drizzle-orm";

import {
  CONFIG_BY_KEY,
  CONFIG_DEFAULTS,
  CONFIG_GROUPS,
  CONFIG_GROUP_KEYS,
  CONFIG_SETTINGS,
  type ConfigSettingDefinition,
  validateConfigValue,
} from "../config-registry.ts";
import type {
  ConfigAdminView,
  ConfigField,
  ConfigKey,
  ConfigSnapshot,
  ConfigValue,
  UpdateConfig,
} from "../contracts/config.ts";
import type { UserRole } from "../contracts/roles.ts";
import { db } from "../db/client.ts";
import { configSettings, users } from "../db/schema/index.ts";
import { AppError } from "../lib/app-error.ts";
import { logger } from "../lib/logger.ts";
import type { RequestContext } from "./auth.service.ts";
import { recordAudit } from "./audit.service.ts";
import type { AuthenticatedPrincipal } from "./session.service.ts";

/**
 * Site configuration (§7). Reads are hot — every quote and every booking asks
 * for the policy — so they go through a short in-process cache; writes are rare,
 * validated against the registry, and audited in the same transaction that
 * stores them.
 */

// ---------------------------------------------------------------------------
// Effective config
// ---------------------------------------------------------------------------

/**
 * The platform's live rules, assembled from the registry's defaults and whatever
 * the admin has overridden. Every consumer reads this shape rather than the KV
 * map, so a typo in a key is a compile error rather than an `undefined` that
 * silently prices a booking at zero.
 */
export interface EffectiveConfig {
  booking: {
    minNoticeHours: number;
    windowMonths: number;
    confirmationSlaDays: number;
    cancellationWindowHours: number;
    noShowRefund: boolean;
    quoteTtlMinutes: number;
    checkoutWindowMinutes: number;
  };
  platform: {
    takeRateBps: number;
    minMarginCents: number;
    expectedStripeFeeBps: number;
    expectedStripeFeeFlatCents: number;
  };
  flags: {
    bookingsEnabled: boolean;
    reviewsEnabled: boolean;
    educatorApplicationsOpen: boolean;
  };
}

/**
 * How long a config read may be stale, per process.
 *
 * A write busts the cache in the instance that served it; other instances catch
 * up within this window. That bound is the reason nothing irreversible keys off
 * a flag alone — the worst case is a booking taken in the seconds after the
 * switch was flipped, which is also the worst case for a deploy-time constant
 * and is handled the same way: by a coordinator, on the booking.
 *
 * Short enough that an admin who edits and reloads sees their own change, long
 * enough that the checkout path isn't a query per quote.
 */
const CACHE_TTL_MS = 20_000;

let cache: { config: EffectiveConfig; expiresAt: number } | null = null;

/** Drops the memoised config. Called after every successful write. */
export function invalidateConfigCache(): void {
  cache = null;
}

/**
 * Reads the stored overrides, dropping anything the registry no longer accepts.
 *
 * A row left behind by a removed setting, or one written before a bound was
 * tightened, is ignored in favour of the default and logged. The alternative —
 * serving it — means a value no form on the platform would accept is what the
 * quote engine runs on, which is the failure mode the validation exists to
 * prevent.
 */
async function readOverrides(): Promise<Map<ConfigKey, ConfigValue>> {
  const rows = await db
    .select({ key: configSettings.key, value: configSettings.value })
    .from(configSettings);

  const overrides = new Map<ConfigKey, ConfigValue>();

  for (const row of rows) {
    const definition = CONFIG_BY_KEY.get(row.key as ConfigKey);
    if (!definition) {
      logger.warn({ key: row.key }, "config row for an unknown setting — ignored");
      continue;
    }

    const value = row.value as ConfigValue;
    const problem = validateConfigValue(definition, value);
    if (problem) {
      logger.warn(
        { key: row.key, value, problem },
        "stored config value fails its own validation — falling back to the default",
      );
      continue;
    }

    overrides.set(definition.key, value);
  }

  return overrides;
}

function num(values: Map<ConfigKey, ConfigValue>, key: ConfigKey): number {
  const value = values.get(key) ?? CONFIG_DEFAULTS[key];
  return typeof value === "number" ? value : Number(value);
}

function bool(values: Map<ConfigKey, ConfigValue>, key: ConfigKey): boolean {
  const value = values.get(key) ?? CONFIG_DEFAULTS[key];
  return value === true;
}

function assemble(values: Map<ConfigKey, ConfigValue>): EffectiveConfig {
  return {
    booking: {
      minNoticeHours: num(values, "booking.min_notice_hours"),
      windowMonths: num(values, "booking.window_months"),
      confirmationSlaDays: num(values, "booking.confirmation_sla_days"),
      cancellationWindowHours: num(values, "booking.cancellation_window_hours"),
      noShowRefund: bool(values, "booking.no_show_refund"),
      quoteTtlMinutes: num(values, "booking.quote_ttl_minutes"),
      checkoutWindowMinutes: num(values, "booking.checkout_window_minutes"),
    },
    platform: {
      takeRateBps: num(values, "platform.take_rate_bps"),
      minMarginCents: num(values, "platform.min_margin_cents"),
      expectedStripeFeeBps: num(values, "platform.expected_stripe_fee_bps"),
      expectedStripeFeeFlatCents: num(values, "platform.expected_stripe_fee_flat_cents"),
    },
    flags: {
      bookingsEnabled: bool(values, "flags.bookings_enabled"),
      reviewsEnabled: bool(values, "flags.reviews_enabled"),
      educatorApplicationsOpen: bool(values, "flags.educator_applications_open"),
    },
  };
}

/**
 * The rules in force. Memoised for `CACHE_TTL_MS`, and falls back to the shipped
 * defaults if the database can't answer — a booking page that can't reach
 * Postgres for its notice window should behave as the code did before the store
 * existed, not refuse every slot.
 */
export async function getEffectiveConfig(): Promise<EffectiveConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.config;

  let config: EffectiveConfig;
  try {
    config = assemble(await readOverrides());
  } catch (error) {
    logger.error(
      { err: error },
      "could not read site configuration — using the shipped defaults",
    );
    return assemble(new Map());
  }

  cache = { config, expiresAt: Date.now() + CACHE_TTL_MS };
  return config;
}

/**
 * Refuses the request when a public entry point has been switched off.
 *
 * The message is the one the parent or applicant reads, so each caller supplies
 * its own: "we've paused new bookings" and "applications are closed" are
 * different sentences and neither is a 500.
 */
export async function assertFlagEnabled(
  flag: keyof EffectiveConfig["flags"],
  message: string,
): Promise<void> {
  const config = await getEffectiveConfig();
  if (config.flags[flag]) return;

  throw new AppError("conflict", message, { logContext: { flag } });
}

// ---------------------------------------------------------------------------
// Public snapshot
// ---------------------------------------------------------------------------

/**
 * The allowlisted slice the public site renders from — the numbers a parent is
 * already shown before they pay, plus the switches that decide whether a form
 * accepts. Nothing from `platform.*` appears here, and the schema has no field
 * that could carry it.
 */
export async function getConfigSnapshot(): Promise<ConfigSnapshot> {
  const config = await getEffectiveConfig();

  return {
    booking: {
      minNoticeHours: config.booking.minNoticeHours,
      windowMonths: config.booking.windowMonths,
      confirmationSlaDays: config.booking.confirmationSlaDays,
      cancellationWindowHours: config.booking.cancellationWindowHours,
      noShowRefund: config.booking.noShowRefund,
    },
    flags: {
      bookingsEnabled: config.flags.bookingsEnabled,
      reviewsEnabled: config.flags.reviewsEnabled,
      educatorApplicationsOpen: config.flags.educatorApplicationsOpen,
    },
  };
}

// ---------------------------------------------------------------------------
// Admin view
// ---------------------------------------------------------------------------

/**
 * What a role may see.
 *
 * A coordinator sees the settings they can act on and nothing else. The
 * alternative — showing them the platform's take rate greyed out — publishes the
 * margin to a role §7 keeps it from, and a control someone can read but never
 * move is not information they can use.
 */
function visibleTo(role: UserRole, definition: ConfigSettingDefinition): boolean {
  if (role === "admin") return true;
  return definition.editableBy === "staff";
}

function editableBy(role: UserRole, definition: ConfigSettingDefinition): boolean {
  if (definition.editableBy === null) return false;
  if (definition.editableBy === "admin") return role === "admin";
  return role === "admin" || role === "coordinator";
}

/** The dashboard's current state, grouped and filtered for the caller's role. */
export async function getConfigAdminView(role: UserRole): Promise<ConfigAdminView> {
  const rows = await db
    .select({
      key: configSettings.key,
      value: configSettings.value,
      updatedAt: configSettings.updatedAt,
      updatedByName: users.fullName,
    })
    .from(configSettings)
    .leftJoin(users, eq(configSettings.updatedBy, users.id));

  const stored = new Map(rows.map((row) => [row.key, row]));

  const groups = CONFIG_GROUP_KEYS.map((groupKey) => {
    const settings: ConfigField[] = CONFIG_SETTINGS.filter(
      (definition) => definition.group === groupKey && visibleTo(role, definition),
    ).map((definition) => {
      const row = stored.get(definition.key);
      /*
       * A row that fails its own validation is reported as the default it is
       * actually being served as. Showing the stored figure would put a number on
       * the screen that no page on the platform is using.
       */
      const usable =
        row && !validateConfigValue(definition, row.value as ConfigValue)
          ? (row.value as ConfigValue)
          : undefined;

      return {
        key: definition.key,
        label: definition.label,
        help: definition.help,
        kind: definition.kind,
        ...(definition.unit ? { unit: definition.unit } : {}),
        ...(definition.min !== undefined ? { min: definition.min } : {}),
        ...(definition.max !== undefined ? { max: definition.max } : {}),
        value: usable ?? definition.defaultValue,
        defaultValue: definition.defaultValue,
        overridden: usable !== undefined,
        editable: editableBy(role, definition),
        ...(definition.lockedReason ? { lockedReason: definition.lockedReason } : {}),
        updatedAt: usable !== undefined ? (row?.updatedAt.toISOString() ?? null) : null,
        updatedByName: usable !== undefined ? (row?.updatedByName ?? null) : null,
      } satisfies ConfigField;
    });

    return {
      title: CONFIG_GROUPS[groupKey].title,
      description: CONFIG_GROUPS[groupKey].description,
      settings,
    };
  }).filter((group) => group.settings.length > 0);

  return {
    groups,
    canEditAny: groups.some((group) => group.settings.some((setting) => setting.editable)),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Applies a batch of settings.
 *
 * Everything is validated before anything is written — per-key bounds, then the
 * caller's role, then the rules that only make sense across the *resulting*
 * state. A batch is all-or-nothing for the same reason a band edit is: a take
 * rate saved without the margin floor it was raised alongside is a state nobody
 * chose.
 *
 * A value equal to its shipped default **deletes** the row rather than storing
 * it, which is what makes `overridden` mean "differs from what shipped" and
 * turns reset-to-default into typing the default back.
 */
export async function updateConfigSettings(
  input: UpdateConfig,
  actor: AuthenticatedPrincipal,
  ctx: RequestContext,
): Promise<{ updated: number }> {
  const fieldErrors: Record<string, string> = {};

  for (const setting of input.settings) {
    const definition = CONFIG_BY_KEY.get(setting.key)!;

    if (definition.editableBy === null) {
      fieldErrors[setting.key] =
        definition.lockedReason ?? "This setting can't be changed from here.";
      continue;
    }
    if (!editableBy(actor.activeRole, definition)) {
      fieldErrors[setting.key] = "Your role can't change this setting.";
      continue;
    }

    const problem = validateConfigValue(definition, setting.value);
    if (problem) fieldErrors[setting.key] = problem;
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError("validation_failed", "Please check the highlighted settings.", {
      fieldErrors,
    });
  }

  const current = await getEffectiveConfig();
  assertCoherent(current, input);

  const previous = await readStoredValues(input.settings.map((s) => s.key));

  const changed = input.settings.filter((setting) => {
    const before = previous.get(setting.key) ?? CONFIG_DEFAULTS[setting.key];
    return before !== setting.value;
  });

  if (changed.length === 0) return { updated: 0 };

  await db.transaction(async (tx) => {
    for (const setting of changed) {
      if (setting.value === CONFIG_DEFAULTS[setting.key]) {
        await tx.delete(configSettings).where(eq(configSettings.key, setting.key));
      } else {
        await tx
          .insert(configSettings)
          .values({
            key: setting.key,
            value: setting.value,
            updatedBy: actor.userId,
          })
          .onConflictDoUpdate({
            target: configSettings.key,
            set: { value: setting.value, updatedBy: actor.userId, updatedAt: new Date() },
          });
      }
    }

    await recordAudit(tx, {
      actorId: actor.userId,
      actorRole: actor.activeRole,
      action: "config.updated",
      entityType: "config_settings",
      /*
       * Null rather than an id: the key is the primary key and it is text, while
       * `audit_log.entity_id` is a uuid. The keys and both states are in
       * `before`/`after`, which is what a revert would read anyway.
       */
      entityId: null,
      before: Object.fromEntries(
        changed.map((setting) => [
          setting.key,
          previous.get(setting.key) ?? CONFIG_DEFAULTS[setting.key],
        ]),
      ),
      after: Object.fromEntries(changed.map((setting) => [setting.key, setting.value])),
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
  });

  invalidateConfigCache();

  return { updated: changed.length };
}

/** The stored overrides for a set of keys — absent means "still the default". */
async function readStoredValues(
  keys: ConfigKey[],
): Promise<Map<ConfigKey, ConfigValue>> {
  if (keys.length === 0) return new Map();

  const rows = await db
    .select({ key: configSettings.key, value: configSettings.value })
    .from(configSettings)
    .where(inArray(configSettings.key, keys));

  return new Map(rows.map((row) => [row.key as ConfigKey, row.value as ConfigValue]));
}

/**
 * Rejects a combination that is individually in range and jointly unsellable.
 *
 * The quote engine computes `margin = total × (take − fee) ÷ 10000 − flat`. That
 * grows with the session's price only while the take rate is **above** the
 * expected card percentage; at or below it, the best margin any booking can
 * reach is `−flat`, whatever the price. So if the floor sits above that figure,
 * the engine's fail-closed guard refuses *every* booking and the first anyone
 * hears of it is a parent being told to phone in.
 *
 * Each number passes its own bounds here — only the combination is wrong, so
 * only a check that sees all four can catch it.
 */
function assertCoherent(current: EffectiveConfig, input: UpdateConfig): void {
  const pending = new Map(input.settings.map((setting) => [setting.key, setting.value]));

  const resolve = (key: ConfigKey, fallback: number): number => {
    const value = pending.get(key);
    return typeof value === "number" ? value : fallback;
  };

  const takeRateBps = resolve("platform.take_rate_bps", current.platform.takeRateBps);
  const feeBps = resolve(
    "platform.expected_stripe_fee_bps",
    current.platform.expectedStripeFeeBps,
  );
  const feeFlatCents = resolve(
    "platform.expected_stripe_fee_flat_cents",
    current.platform.expectedStripeFeeFlatCents,
  );
  const minMarginCents = resolve(
    "platform.min_margin_cents",
    current.platform.minMarginCents,
  );

  // Above the fee the margin rises with the session price, so some price clears
  // any floor. At or below it, `−flat` is the ceiling.
  if (takeRateBps > feeBps) return;
  if (-feeFlatCents >= minMarginCents) return;

  throw new AppError(
    "validation_failed",
    `A ${takeRateBps / 100}% take rate doesn't clear the ${feeBps / 100}% card fee, so ` +
      "no session at any price would reach the margin floor — every booking would be " +
      "refused at checkout. Raise the take rate above the card fee.",
    {
      fieldErrors: {
        "platform.take_rate_bps": "Must be above the expected card fee.",
      },
    },
  );
}
