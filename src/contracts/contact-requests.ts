/**
 * The public contact form, and the queue staff work it from.
 *
 * Two things shape these types. First, the endpoint is **public and
 * unauthenticated**, so the submit shape is the smallest thing that can carry an
 * enquiry and nothing that could be used to set state — no status, no assignee,
 * no ids.
 *
 * Second, this is **not a messaging feature**. Staff reply from their own mail
 * client, and what is recorded here is who owns an enquiry and what came of it.
 * There is deliberately no reply body in either direction: storing one side of a
 * conversation invites the reader to believe it is the whole of it.
 */

import { z } from "zod";

/** Why someone is writing, in the order the form offers them. */
export const CONTACT_REASONS = [
  "finding_educator",
  "pricing",
  "booking_help",
  "other",
] as const;

export const contactReasonSchema = z.enum(CONTACT_REASONS);
export type ContactReason = (typeof CONTACT_REASONS)[number];

/**
 * The labels the form shows. Held with the values so the two can't drift into
 * disagreeing about what `pricing` means on a staff screen.
 */
export const CONTACT_REASON_LABELS: Record<ContactReason, string> = {
  finding_educator: "Finding an educator",
  pricing: "Pricing question",
  booking_help: "Booking help",
  other: "Something else",
};

export const CONTACT_REQUEST_STATUSES = [
  "new",
  "in_progress",
  "resolved",
  "spam",
] as const;

export const contactRequestStatusSchema = z.enum(CONTACT_REQUEST_STATUSES);
export type ContactRequestStatus = (typeof CONTACT_REQUEST_STATUSES)[number];

/** Long enough for a real problem, short enough not to be a payload. */
const MESSAGE_MAX = 4000;

export const submitContactRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Please tell us your name.")
      .max(120, "That's longer than we can store."),
    email: z.email("Please enter a valid email address."),
    phone: z
      .string()
      .trim()
      .max(40, "That's longer than we can store.")
      .optional(),
    reason: contactReasonSchema,
    message: z
      .string()
      .trim()
      .min(1, "Please tell us how we can help.")
      .max(MESSAGE_MAX, `Please keep this under ${MESSAGE_MAX} characters.`),
    /**
     * A honeypot. Hidden from people and left empty by them; bots fill every
     * field they find. Anything here means the submission is discarded, which is
     * cheaper and quieter than a challenge — and this form has no CAPTCHA yet.
     *
     * Deliberately unconstrained: a rule like `max(0)` would make a filled trap
     * fail validation, and the error names the field. That hands a bot the one
     * thing the trap depends on it not knowing, so what to do about a filled
     * honeypot is the handler's decision, not the schema's.
     */
    website: z.string().optional(),
  })
  .strict();

export type SubmitContactRequest = z.infer<typeof submitContactRequestSchema>;

/**
 * What staff change: who owns it, where it is, and what came of it.
 *
 * Every field is optional so claiming, progressing and resolving are the same
 * call, but at least one has to be present — a PATCH that changes nothing is a
 * mistake worth surfacing rather than a no-op worth accepting.
 */
export const updateContactRequestSchema = z
  .object({
    status: contactRequestStatusSchema.optional(),
    /** `null` releases it back to the queue. */
    assignToSelf: z.boolean().optional(),
    unassign: z.boolean().optional(),
    resolutionNote: z
      .string()
      .trim()
      .max(2000, "Please keep this under 2000 characters.")
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === undefined &&
      value.assignToSelf === undefined &&
      value.unassign === undefined &&
      value.resolutionNote === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Nothing to change.",
      });
    }

    if (value.assignToSelf && value.unassign) {
      ctx.addIssue({
        code: "custom",
        path: ["unassign"],
        message: "Pick one: take it, or release it.",
      });
    }

    // Resolving without saying what happened leaves the next reader with a
    // closed enquiry and no idea whether it was answered.
    if (value.status === "resolved" && !value.resolutionNote) {
      ctx.addIssue({
        code: "custom",
        path: ["resolutionNote"],
        message: "Say what came of it before resolving.",
      });
    }
  });

export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

/**
 * One enquiry as staff see it. There is no public read of this shape at all —
 * the sender gets an acknowledgement email and nothing else.
 */
export const contactRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  phone: z.string().nullable(),
  reason: contactReasonSchema,
  message: z.string(),
  status: contactRequestStatusSchema,
  /** The coordinator holding it, resolved to a name for display. */
  assignedToName: z.string().nullable(),
  assignedToId: z.uuid().nullable(),
  /** Present when the sender was signed in, so their account can be opened. */
  senderUserId: z.uuid().nullable(),
  firstRespondedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type ContactRequestRecord = z.infer<typeof contactRequestSchema>;

export const contactRequestQuerySchema = z
  .object({
    status: contactRequestStatusSchema.optional(),
    /**
     * Only what this coordinator has taken, for working your own list.
     *
     * Parsed from the two strings a query string can carry rather than coerced:
     * `z.coerce.boolean()` reads *any* non-empty string as true, so `?mine=false`
     * would mean the opposite of what it says.
     */
    mine: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ContactRequestQuery = z.infer<typeof contactRequestQuerySchema>;

export const contactRequestListResponseSchema = z.object({
  items: z.array(contactRequestSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
  limit: z.number().int(),
  offset: z.number().int(),
  /**
   * How many sit in each status regardless of the current filter, so an
   * unattended queue is visible from a screen that is filtered to something else.
   */
  counts: z.object({
    new: z.number().int(),
    in_progress: z.number().int(),
    resolved: z.number().int(),
    spam: z.number().int(),
  }),
});

export type ContactRequestListResponse = z.infer<
  typeof contactRequestListResponseSchema
>;
