import { z } from "zod";

import { emailSchema, fullNameSchema } from "./auth.ts";
import { userRoleSchema } from "./roles.ts";

/**
 * Staff account lifecycle, mirroring the DB's `user_status` enum. `invited`
 * means the coordinator has not opened their invite yet — the account exists
 * but cannot authenticate until they set a password.
 */
export const USER_STATUSES = ["invited", "active", "suspended", "deactivated"] as const;

export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/**
 * Admin invites a coordinator. No password: the invitee sets their own via the
 * emailed single-use link, the same acceptance path educators use — staff
 * accounts are never created with a credential someone else chose.
 */
export const inviteCoordinatorRequestSchema = z
  .object({
    fullName: fullNameSchema,
    email: emailSchema,
    phone: z.string().trim().max(40).optional(),
  })
  .strict();

export type InviteCoordinatorRequest = z.infer<typeof inviteCoordinatorRequestSchema>;

/** One row in the admin's staff directory. `roles` holds the staff grants only. */
export const staffMemberSchema = z.object({
  userId: z.uuid(),
  fullName: z.string(),
  email: z.email(),
  roles: z.array(userRoleSchema),
  status: userStatusSchema,
  createdAt: z.iso.datetime(),
});

export type StaffMember = z.infer<typeof staffMemberSchema>;
