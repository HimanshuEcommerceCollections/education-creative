import { z } from "zod";

import { emailSchema, fullNameSchema } from "./auth.ts";
import { STAFF_ROLES, userRoleSchema } from "./roles.ts";

/**
 * Staff account lifecycle, mirroring the DB's `user_status` enum. `invited`
 * means the coordinator has not opened their invite yet — the account exists
 * but cannot authenticate until they set a password.
 */
export const USER_STATUSES = ["invited", "active", "suspended", "deactivated"] as const;

export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** The two roles this surface can grant. Educator profiles come from approval. */
export const staffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof staffRoleSchema>;

/**
 * Admin invites a member of staff. No password: the invitee sets their own via
 * the emailed single-use link, the same acceptance path educators use — staff
 * accounts are never created with a credential someone else chose.
 *
 * `role` defaults to `coordinator` because that is the common case, but an admin
 * inviting another admin is deliberately reachable from here: the alternative
 * was `npm run seed:admin` on a server, which is not a thing an operator can do.
 */
export const inviteStaffRequestSchema = z
  .object({
    fullName: fullNameSchema,
    email: emailSchema,
    phone: z.string().trim().max(40).optional(),
    role: staffRoleSchema.default("coordinator"),
  })
  .strict();

export type InviteStaffRequest = z.infer<typeof inviteStaffRequestSchema>;

/**
 * The pre-`role` name of the schema above. Kept so the dashboard's existing
 * invite form keeps compiling against the generated contract copy; new callers
 * should use `inviteStaffRequestSchema`.
 *
 * @deprecated
 */
export const inviteCoordinatorRequestSchema = inviteStaffRequestSchema;
export type InviteCoordinatorRequest = InviteStaffRequest;

/** Grant a staff role to an account that already exists. */
export const grantStaffRoleRequestSchema = z
  .object({ role: staffRoleSchema })
  .strict();

export type GrantStaffRoleRequest = z.infer<typeof grantStaffRoleRequestSchema>;

/**
 * Suspend, deactivate, or restore an account.
 *
 * `suspended` is the reversible one — the account keeps its roles and its rows
 * and simply stops authenticating. `deactivated` means the same thing to every
 * read path; the distinction is intent, and it is recorded in the audit row
 * rather than enforced differently anywhere.
 */
export const setUserStatusRequestSchema = z
  .object({
    status: z.enum(["active", "suspended", "deactivated"]),
    reason: z.string().trim().min(3, "Say why — this ends up in the audit log.").max(1000),
  })
  .strict();

export type SetUserStatusRequest = z.infer<typeof setUserStatusRequestSchema>;

/**
 * The live invite on an account, when there is one.
 *
 * Without this an admin looking at an `invited` row cannot tell a fresh invite
 * from one that expired three weeks ago — the two look identical, and only one
 * of them needs a resend. `null` means there is no unused token at all, which is
 * the state a failed invite email leaves behind.
 */
export const staffInviteStateSchema = z.object({
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
});

export type StaffInviteState = z.infer<typeof staffInviteStateSchema>;

/** One row in the admin's staff directory. `roles` holds the staff grants only. */
export const staffMemberSchema = z.object({
  userId: z.uuid(),
  fullName: z.string(),
  email: z.email(),
  roles: z.array(userRoleSchema),
  status: userStatusSchema,
  createdAt: z.iso.datetime(),
  invite: staffInviteStateSchema.nullable(),
});

export type StaffMember = z.infer<typeof staffMemberSchema>;
