/**
 * The API's public contract. The Next app imports from here (via its
 * `@contracts/*` path alias) so request shapes, password rules, role
 * precedence, consent copy, and error codes have exactly one definition.
 *
 * Nothing in this directory may import from `../db`, `../services`, or `../env`
 * — it has to stay safe for a browser bundle to pull in.
 */
export * from "./roles.ts";
export * from "./errors.ts";
export * from "./consent.ts";
export * from "./auth.ts";
export * from "./bookings.ts";
export * from "./educator-applications.ts";
export * from "./educators.ts";
export * from "./reviews.ts";
export * from "./contact-requests.ts";
export * from "./staff-invites.ts";
export * from "./pricing.ts";
export * from "./config.ts";
