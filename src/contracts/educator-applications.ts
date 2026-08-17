import { z } from "zod";

import { emailSchema, fullNameSchema } from "./auth.ts";

export const EDUCATOR_APPLICATION_STATUSES = [
  "submitted",
  "in_review",
  "approved",
  "rejected",
] as const;

export const educatorApplicationStatusSchema = z.enum(EDUCATOR_APPLICATION_STATUSES);
export type EducatorApplicationStatus = z.infer<typeof educatorApplicationStatusSchema>;

/**
 * Mirrors the fields the existing `/become-a-tutor` form already collects. No
 * password: an application creates no account, so there is nothing to set a
 * credential on until a coordinator approves it.
 */
export const submitEducatorApplicationSchema = z
  .object({
    applicantName: fullNameSchema,
    email: emailSchema,
    phone: z.string().trim().max(40).optional(),
    /** Subject slugs. The form offers one today; the array is future-proofing. */
    subjectsOfInterest: z
      .array(z.string().trim().min(1))
      .min(1, "Please choose a subject.")
      .max(20),
    yearsExperience: z.string().trim().max(40).optional(),
    about: z
      .string()
      .trim()
      .min(20, "Please tell us a little more — a few sentences is plenty.")
      .max(4000),
  })
  .strict();

export type SubmitEducatorApplication = z.infer<typeof submitEducatorApplicationSchema>;

/**
 * Staff-facing view. `reviewNotes` is internal and never sent to an applicant.
 *
 * This is the allowlist the list and detail endpoints project to — the row also
 * carries `updatedAt`, which nothing outside the database has a use for.
 */
export const educatorApplicationSchema = z.object({
  id: z.uuid(),
  applicantName: z.string(),
  email: z.email(),
  phone: z.string().nullable(),
  subjectsOfInterest: z.array(z.string()),
  yearsExperience: z.string().nullable(),
  about: z.string(),
  status: educatorApplicationStatusSchema,
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewNotes: z.string().nullable(),
  backgroundCheckRef: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type EducatorApplication = z.infer<typeof educatorApplicationSchema>;

export const listEducatorApplicationsQuerySchema = z
  .object({
    status: educatorApplicationStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/**
 * Paged list. The queue is ordered newest-first, so without `total`/`hasMore` a
 * caller that filters client-side cannot tell "no unreviewed applications" from
 * "the unreviewed ones are past the window" — and the oldest, most overdue
 * application is exactly the one that falls out of it.
 */
export const educatorApplicationListResponseSchema = z.object({
  items: z.array(educatorApplicationSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export type EducatorApplicationListResponse = z.infer<
  typeof educatorApplicationListResponseSchema
>;

export const reviewEducatorApplicationSchema = z
  .object({
    status: z.enum(["in_review", "rejected"]),
    reviewNotes: z.string().trim().max(4000).optional(),
  })
  .strict();

/**
 * Approval is its own endpoint rather than a status value on the review call,
 * because it has side effects a plain status change does not: it creates a
 * `users` row, grants the educator role, creates the profile, and emails an
 * invite. Keeping it separate makes those effects impossible to trigger by
 * accident.
 */
export const approveEducatorApplicationSchema = z
  .object({
    /** Profile slug. Defaults to a slugified applicant name when omitted. */
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens.")
      .max(120)
      .optional(),
    headline: z.string().trim().max(200).optional(),
    /** Pass/fail reference from the vetting vendor — never the ID document. */
    backgroundCheckRef: z.string().trim().max(200).optional(),
    reviewNotes: z.string().trim().max(4000).optional(),
  })
  .strict();
