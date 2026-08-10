import Stripe from "stripe";

import { env } from "../env.ts";

/**
 * The Stripe client, and the machinery that makes a **shared Stripe account**
 * safe to run this project on.
 *
 * ## The hazard
 *
 * A Stripe account fans every event of a subscribed type out to *every* webhook
 * endpoint registered on it. Endpoints are not scoped to an integration, an API
 * key, or a set of objects. So if this project and another share an account, this
 * service receives the other project's `payment_intent.succeeded`,
 * `charge.refunded` and `charge.dispute.created` as though they were its own.
 *
 * That is not a cosmetic problem. §8 requires that a succeeded PaymentIntent with
 * no matching local booking be **refunded**, because it represents money taken
 * for something we cannot deliver. Run that rule over a sibling project's traffic
 * and this service will refund their revenue — promptly, and with a clean audit
 * trail showing it did exactly what it was told.
 *
 * ## The defence, in two layers
 *
 * 1. **Tag on the way out.** Every object this project creates carries
 *    `metadata.project = STRIPE_PROJECT_KEY`, on the Checkout Session *and* on
 *    the PaymentIntent beneath it.
 * 2. **Match on the way in.** The webhook resolves ownership before any handler
 *    runs, and the destructive paths require a *positive* match. Absence of
 *    evidence is never treated as ours.
 *
 * ## What this is not
 *
 * It is not as good as separate accounts. Tagging cannot stop the other project's
 * endpoint from receiving *our* events, and it cannot stop a sibling that skipped
 * this discipline from acting on them. If both projects take real money, give each
 * its own Stripe account — or at minimum its own sandbox, which is free and
 * isolates test traffic completely. This module makes a shared account survivable;
 * it does not make it correct.
 */

let client: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY &&
      env.STRIPE_WEBHOOK_SECRET &&
      env.STRIPE_PUBLISHABLE_KEY &&
      env.STRIPE_PROJECT_KEY,
  );
}

/**
 * Lazy, so a deployment with no Stripe configured boots fine and only the
 * payment endpoints refuse. The env schema already enforces all-or-nothing, so
 * reaching here half-configured is impossible.
 */
export function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe is not configured: STRIPE_SECRET_KEY is unset.");
  }

  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    /*
     * No explicit `apiVersion`. The SDK pins the version it was built and typed
     * against; naming a different one here type-checks but makes the responses
     * and the types disagree at runtime, which is a worse failure than being a
     * version behind. Upgrade by upgrading the package.
     */
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "Your Learning Journey", url: env.WEB_ORIGIN },
  });

  return client;
}

export function stripePublishableKey(): string {
  if (!env.STRIPE_PUBLISHABLE_KEY) {
    throw new Error("Stripe is not configured: STRIPE_PUBLISHABLE_KEY is unset.");
  }
  return env.STRIPE_PUBLISHABLE_KEY;
}

export function stripeWebhookSecret(): string {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("Stripe is not configured: STRIPE_WEBHOOK_SECRET is unset.");
  }
  return env.STRIPE_WEBHOOK_SECRET;
}

/** This project's tag. Two projects on one account must never share a value. */
export function projectKey(): string {
  if (!env.STRIPE_PROJECT_KEY) {
    throw new Error("Stripe is not configured: STRIPE_PROJECT_KEY is unset.");
  }
  return env.STRIPE_PROJECT_KEY;
}

/** The metadata key carrying the tag. Also grep-able in the Stripe dashboard. */
export const PROJECT_METADATA_KEY = "project";

/**
 * Metadata for anything we create. Always spread this rather than writing a bare
 * object literal — an object created without the tag is invisible to the webhook
 * filter and will be treated as a foreign project's.
 */
export function projectMetadata(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { [PROJECT_METADATA_KEY]: projectKey(), ...extra };
}

/** Anything Stripe sends that might carry metadata. */
interface MaybeTagged {
  metadata?: Stripe.Metadata | null;
}

/** The project tag on a Stripe object, or null when it carries none. */
export function readProjectTag(object: unknown): string | null {
  const metadata = (object as MaybeTagged | null)?.metadata;
  const tag = metadata?.[PROJECT_METADATA_KEY];
  return typeof tag === "string" && tag.length > 0 ? tag : null;
}

/**
 * Ownership verdict for an inbound event.
 *
 * - `ours`      — tagged with our key. Handle it.
 * - `foreign`   — tagged with someone else's. Record and ignore.
 * - `untagged`  — no tag at all. **Not** assumed ours.
 *
 * `untagged` is its own verdict rather than folded into `foreign` because the two
 * want different treatment. A Charge does not reliably inherit its
 * PaymentIntent's metadata, so a `charge.refunded` for one of our own payments can
 * legitimately arrive untagged — those are resolved by looking the id up in our
 * `payments` table, which is authoritative. What `untagged` must never do is
 * license a destructive action on the assumption that unlabelled means ours.
 */
export type EventOwnership = "ours" | "foreign" | "untagged";

export function classifyOwnership(object: unknown): EventOwnership {
  const tag = readProjectTag(object);
  if (tag === null) return "untagged";
  return tag === projectKey() ? "ours" : "foreign";
}

/**
 * Deterministic idempotency key.
 *
 * Derived from what the request *is* rather than randomly generated, so a retry
 * after a network timeout — where we never learned whether Stripe acted — reuses
 * the same key and cannot produce a second charge or a second refund.
 *
 * Namespaced by project so two projects on one account can't collide on a key
 * built from, say, the same booking sequence number.
 */
export function idempotencyKey(...parts: (string | number)[]): string {
  return [projectKey(), ...parts].join(":");
}
