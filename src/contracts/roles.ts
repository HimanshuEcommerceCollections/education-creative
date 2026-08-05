import { z } from "zod";

export const USER_ROLES = ["admin", "coordinator", "educator", "customer"] as const;

export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * Highest privilege first. A user holding several roles gets the first match as
 * their session's `activeRole` and their post-login destination — the decision
 * recorded for multi-role users. Order is load-bearing: changing it changes
 * where a parent-who-is-also-an-educator lands.
 */
export const ROLE_PRECEDENCE = ["admin", "coordinator", "educator", "customer"] as const;

/** Roles subject to the short idle window, no remember-me, and mandatory TOTP. */
export const STAFF_ROLES = ["admin", "coordinator"] as const;

export function isStaffRole(role: UserRole): boolean {
  return (STAFF_ROLES as readonly UserRole[]).includes(role);
}

/**
 * Resolves the session's active role. Returns null for an account with no
 * grants at all — an authenticated principal with zero capability, which the
 * login route rejects rather than issuing a roleless session.
 */
export function resolveActiveRole(roles: readonly UserRole[]): UserRole | null {
  return ROLE_PRECEDENCE.find((role) => roles.includes(role)) ?? null;
}

/**
 * Where each role lands after login. Computed server-side and handed to the
 * client as an opaque destination, so the browser never decides this from a
 * role it could tamper with.
 */
export const ROLE_HOME: Record<UserRole, string> = {
  admin: "/dashboard",
  coordinator: "/dashboard",
  educator: "/educator",
  customer: "/",
};

export function homeForRole(role: UserRole): string {
  return ROLE_HOME[role];
}
