import { z } from "zod";

import { fullNameSchema } from "./auth.ts";
import { userStatusSchema } from "./staff-invites.ts";

/**
 * Educator profiles — the record a coordinator vets and an educator maintains.
 *
 * Two things here gate real behaviour rather than describing it:
 *
 * - `verificationStatus` is the child-safety invariant (§5). A booking cannot be
 *   confirmed, and no learner detail may be released, unless it is `approved`.
 *   Nothing but the staff endpoint in `educator.routes.ts` moves it.
 * - `subjects` is the authoritative list of what an educator teaches. The
 *   booking form offers exactly these strings and the quote path rejects a topic
 *   that isn't among them, so an empty list is not a neutral default — it is a
 *   profile that hasn't been completed.
 */

export const EDUCATOR_VERIFICATION_STATUSES = [
  "draft",
  "pending",
  "approved",
  "suspended",
] as const;

export const educatorVerificationStatusSchema = z.enum(EDUCATOR_VERIFICATION_STATUSES);
export type EducatorVerificationStatus = z.infer<typeof educatorVerificationStatusSchema>;

/**
 * Free-text topics ("Piano", "Algebra"), not subject slugs — the coarse
 * categories live in `subjects` and carry the rate bands. These strings are what
 * the booking form offers, so they are compared verbatim.
 */
const subjectTopicsSchema = z
  .array(z.string().trim().min(1, "A topic can't be blank.").max(80))
  .max(40, "That's more topics than a profile should carry.");

/** Stored as an array of paragraphs, which is how the profile page renders it. */
const aboutSchema = z
  .array(z.string().trim().min(1, "A paragraph can't be blank.").max(2000))
  .max(20);

const headlineSchema = z.string().trim().max(200);

/**
 * Shared by the educator's own edit and staff's. Every field is optional so a
 * caller can send only what changed, and the refinement below rejects the empty
 * body that would otherwise write an audit row describing no change.
 */
const profileFields = {
  headline: headlineSchema.nullable().optional(),
  about: aboutSchema.optional(),
  subjects: subjectTopicsSchema.optional(),
};

function requireOneField(value: object, ctx: z.RefinementCtx): void {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({ code: "custom", message: "Nothing to update." });
  }
}

export const updateEducatorProfileSchema = z
  .object(profileFields)
  .strict()
  .superRefine(requireOneField);

export type UpdateEducatorProfile = z.infer<typeof updateEducatorProfileSchema>;

/** Staff may additionally correct the displayed name; the slug is not editable. */
export const staffUpdateEducatorProfileSchema = z
  .object({ ...profileFields, name: fullNameSchema.optional() })
  .strict()
  .superRefine(requireOneField);

export type StaffUpdateEducatorProfile = z.infer<typeof staffUpdateEducatorProfileSchema>;

/**
 * The verification transition. `draft` is absent deliberately: nothing creates a
 * draft profile, so offering it would only let staff move an educator into a
 * state no other code path expects.
 *
 * `reason` is mandatory because this is the write the child-safety invariant
 * hangs off — an approval with no recorded justification is exactly what an
 * audit of it needs and wouldn't have.
 */
export const setEducatorVerificationSchema = z
  .object({
    status: z.enum(["pending", "approved", "suspended"]),
    reason: z
      .string()
      .trim()
      .min(3, "Say why — this is the record of the decision.")
      .max(1000),
    /** Pass/fail reference from the vetting vendor — never the ID document. */
    backgroundCheckRef: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "approved" && !value.backgroundCheckRef) {
      ctx.addIssue({
        code: "custom",
        path: ["backgroundCheckRef"],
        message: "Record the vetting reference before approving an educator.",
      });
    }
  });

export type SetEducatorVerification = z.infer<typeof setEducatorVerificationSchema>;

export const listEducatorsQuerySchema = z
  .object({
    verificationStatus: educatorVerificationStatusSchema.optional(),
    /**
     * Free text matched against the name and the subjects they teach. Server-side
     * because the list is paged: filtering in the browser would only ever search
     * the page in front of you, which is worse than not offering search at all.
     */
    q: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListEducatorsQuery = z.infer<typeof listEducatorsQuerySchema>;

/**
 * What an educator sees of their own profile. `backgroundCheckAt` is here so they
 * can tell "not looked at yet" from "cleared in March"; the vendor's reference
 * is not — that's an internal record about them, not for them.
 */
export const educatorProfileSchema = z.object({
  slug: z.string(),
  name: z.string(),
  headline: z.string().nullable(),
  about: z.array(z.string()),
  subjects: z.array(z.string()),
  verificationStatus: educatorVerificationStatusSchema,
  backgroundCheckAt: z.iso.datetime().nullable(),
  minRateCents: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
});

export type EducatorProfile = z.infer<typeof educatorProfileSchema>;

/**
 * The staff view. Adds the account the profile belongs to — a profile whose
 * `accountStatus` is still `invited` has never been signed into, which is the
 * difference between "not set up yet" and "set up and not vetted".
 */
export const staffEducatorProfileSchema = educatorProfileSchema.extend({
  userId: z.uuid().nullable(),
  email: z.email().nullable(),
  accountStatus: userStatusSchema.nullable(),
  applicationId: z.uuid().nullable(),
  /** Lives on the application row, which is where the vetting record is kept. */
  backgroundCheckRef: z.string().nullable(),
});

export type StaffEducatorProfile = z.infer<typeof staffEducatorProfileSchema>;

/**
 * A session this educator is committed to teaching.
 *
 * Carried on the detail view because suspending someone does not cancel what they
 * have already been assigned: the sessions stay on the books, and a coordinator
 * suspending an educator needs to see what they are about to leave unattended
 * rather than discover it from a parent. Only what identifies the session — the
 * learner is not named here.
 */
export const educatorCommitmentSchema = z.object({
  reference: z.string(),
  preferredDate: z.string(),
  preferredTime: z.string(),
  subjectTopic: z.string(),
});

export type EducatorCommitment = z.infer<typeof educatorCommitmentSchema>;

/**
 * One educator in full.
 *
 * Separate from the list shape because `confirmedBookings` costs a join per
 * educator, and a directory of fifty would pay it fifty times to show something
 * only the detail view reads.
 */
export const staffEducatorDetailSchema = staffEducatorProfileSchema.extend({
  confirmedBookings: z.array(educatorCommitmentSchema),
});

export type StaffEducatorDetail = z.infer<typeof staffEducatorDetailSchema>;

/**
 * Paged list. `total` and `hasMore` are both present because a caller needs one
 * of them for a pager and the other for "3 educators awaiting a check" — and
 * neither can be derived from a bare array.
 */
export const educatorListResponseSchema = z.object({
  items: z.array(staffEducatorProfileSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export type EducatorListResponse = z.infer<typeof educatorListResponseSchema>;
