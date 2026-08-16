import { SITE_NAME } from "../../constants.ts";
import { env } from "../../env.ts";
import type { EmailMessage } from "./types.ts";

/** All links point at the Next origin, never the API's. */
function webUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, env.WEB_ORIGIN);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

const signOff = `— The ${SITE_NAME} team`;

export function verifyEmailTemplate(name: string, token: string): EmailMessage {
  return {
    to: "",
    subject: `Confirm your email · ${SITE_NAME}`,
    text: [
      `Hi ${name},`,
      "",
      "Please confirm your email address so we can send you booking updates:",
      "",
      webUrl("/verify-email", { token }),
      "",
      "The link is good for 24 hours. If you didn't create an account, you can ignore this.",
      "",
      signOff,
    ].join("\n"),
  };
}

export function passwordResetTemplate(name: string, token: string): EmailMessage {
  return {
    to: "",
    subject: `Reset your password · ${SITE_NAME}`,
    text: [
      `Hi ${name},`,
      "",
      "Use this link to choose a new password:",
      "",
      webUrl("/reset-password", { token }),
      "",
      "The link is good for one hour and can only be used once. Resetting your",
      "password signs you out everywhere.",
      "",
      "If you didn't ask for this, no action is needed — your password is unchanged.",
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent to an approved educator. This is the only way an educator account ever
 * gets a password, which is what makes "invite-only after approval" real.
 */
export function educatorInviteTemplate(name: string, token: string): EmailMessage {
  return {
    to: "",
    subject: `You're approved — set up your ${SITE_NAME} account`,
    text: [
      `Hi ${name},`,
      "",
      "Good news: your application has been approved. Set a password to activate",
      "your educator account and see your assignments:",
      "",
      webUrl("/accept-invite", { token }),
      "",
      "The link is good for 7 days and can only be used once. If it expires, reply",
      "to this email and we'll send a fresh one.",
      "",
      signOff,
    ].join("\n"),
  };
}

export function staffInviteTemplate(
  name: string,
  token: string,
  role: string,
): EmailMessage {
  return {
    to: "",
    subject: `Your ${SITE_NAME} ${role} account`,
    text: [
      `Hi ${name},`,
      "",
      `You've been invited as a ${role}. Set a password to activate your account:`,
      "",
      webUrl("/accept-invite", { token }),
      "",
      "The link is good for 7 days and can only be used once.",
      "",
      signOff,
    ].join("\n"),
  };
}

export function applicationReceivedTemplate(name: string): EmailMessage {
  return {
    to: "",
    subject: `We've got your application · ${SITE_NAME}`,
    text: [
      `Hi ${name},`,
      "",
      "Thanks for applying to teach with us. Our team reviews every application",
      "and runs a background check before an educator is listed, so this takes a",
      "few days. We'll email you either way — there's nothing you need to do in",
      "the meantime, and there's no account to sign in to yet.",
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent to whoever wrote in through the public contact form.
 *
 * It promises no response time, because nothing measures one yet — a stated
 * turnaround this platform can't observe is a promise it will break by accident.
 * Their own message is quoted back so they have a copy of what they sent, and
 * nothing internal goes with it: no reference, no status, no name of whoever
 * ends up picking it up.
 */
export function contactRequestReceivedTemplate(input: {
  name: string;
  message: string;
}): EmailMessage {
  return {
    to: "",
    subject: `We've got your message · ${SITE_NAME}`,
    text: [
      `Hi ${input.name},`,
      "",
      "Thanks for getting in touch. Your message has reached our team and someone",
      "will come back to you by email. There's nothing you need to do in the",
      "meantime.",
      "",
      "Here's what you sent us:",
      "",
      // Indented so a multi-line message reads as a quotation of theirs rather
      // than as more of ours.
      ...input.message.split("\n").map((line) => `  ${line}`),
      "",
      signOff,
    ].join("\n"),
  };
}

/** `$58` / `$82.50` — cents in, no trailing `.00`, so a price reads as a price. */
function money(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Sent when a coordinator confirms. This is the first message that names a real
 * educator and a real time, because until the confirm both were a request.
 */
export function bookingConfirmedTemplate(input: {
  parentName: string;
  reference: string;
  educatorName: string;
  when: string;
  substituted: boolean;
}): EmailMessage {
  return {
    to: "",
    subject: `Your session is confirmed · ${input.reference}`,
    text: [
      `Hi ${input.parentName},`,
      "",
      `Your session is confirmed for ${input.when}, with ${input.educatorName}.`,
      ...(input.substituted
        ? [
            "",
            "This is a different educator than the one you requested — the educator you",
            "asked for wasn't available for this time, so we've assigned someone who is.",
            "If you'd rather wait for your first choice, reply to this email and we'll",
            "sort it out.",
          ]
        : []),
      "",
      `Reference: ${input.reference}`,
      "",
      "A parent or guardian supervises every session. You can see this booking and",
      "everything else you've booked here:",
      "",
      webUrl("/account/bookings"),
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent when the platform can't fulfil a paid booking. It leads with the refund,
 * because that is the parent's first question and burying it reads as evasion.
 */
export function bookingCouldNotConfirmTemplate(input: {
  parentName: string;
  reference: string;
  reason: string;
  refundedCents: number;
  currency: string;
}): EmailMessage {
  return {
    to: "",
    subject: `We've refunded your session · ${input.reference}`,
    text: [
      `Hi ${input.parentName},`,
      "",
      `We weren't able to confirm this session, so we've refunded ${money(
        input.refundedCents,
        input.currency,
      )} in full.`,
      "It usually reaches your account in 5–10 business days, depending on your bank.",
      "",
      `Why: ${input.reason}`,
      "",
      `Reference: ${input.reference}`,
      "",
      "We're sorry to have taken the payment and not delivered. If you'd like to try",
      "a different time or educator, you can book again here:",
      "",
      webUrl("/book"),
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent for a discretionary refund, whole or partial.
 *
 * Separate from the could-not-confirm message because the situations read
 * differently to a family: one is us failing to staff a session, this one is a
 * decision about a session that happened. The amount leads either way.
 */
export function bookingRefundedTemplate(input: {
  parentName: string;
  reference: string;
  reason: string;
  refundedCents: number;
  currency: string;
  partial: boolean;
}): EmailMessage {
  const amount = money(input.refundedCents, input.currency);
  return {
    to: "",
    subject: `A refund of ${amount} · ${input.reference}`,
    text: [
      `Hi ${input.parentName},`,
      "",
      input.partial
        ? `We've refunded ${amount} of this booking.`
        : `We've refunded ${amount} — the full remaining amount on this booking.`,
      "It usually reaches your account in 5–10 business days, depending on your bank.",
      "",
      `Why: ${input.reason}`,
      "",
      `Reference: ${input.reference}`,
      "",
      "If this doesn't look right, reply to this email and a person will pick it up.",
      "",
      webUrl("/account/bookings"),
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent to the assigned educator. Deliberately carries no learner name and no
 * address — those are child data (§5/§9) and are released through the audited
 * detail endpoint behind their own sign-in, never pushed into an inbox.
 */
export function bookingAssignedTemplate(input: {
  educatorName: string;
  reference: string;
  when: string;
  subjectTopic: string;
  format: "in_home" | "online";
}): EmailMessage {
  return {
    to: "",
    subject: `New session assigned to you · ${input.reference}`,
    text: [
      `Hi ${input.educatorName},`,
      "",
      `You've been assigned a ${
        input.format === "in_home" ? "in-home" : "online"
      } ${input.subjectTopic} session for ${input.when}.`,
      "",
      "The learner's details and, for in-home sessions, the address are on your",
      "dashboard — we don't put them in email:",
      "",
      webUrl("/educator/sessions"),
      "",
      `Reference: ${input.reference}`,
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent to both sides when a session moves. One template rather than two because
 * the two times are the whole message and must read identically to everyone
 * holding the date; `audience` only decides which dashboard is linked and which
 * wording is honest for the reader.
 *
 * The old time and the new one are labelled and on their own lines. A sentence
 * carrying both — "moved from X to Y" — is the one shape a skim-reader inverts,
 * and the cost of that is a family at home on the wrong afternoon.
 */
export function bookingRescheduledTemplate(input: {
  recipientName: string;
  reference: string;
  previousWhen: string;
  newWhen: string;
  reason: string;
  audience: "parent" | "educator";
}): EmailMessage {
  const forParent = input.audience === "parent";
  return {
    to: "",
    subject: `Your session has moved · ${input.reference}`,
    text: [
      `Hi ${input.recipientName},`,
      "",
      forParent
        ? "We've moved your session to a new time."
        : "A session you're teaching has moved to a new time.",
      "",
      `  Was:  ${input.previousWhen}`,
      `  Now:  ${input.newWhen}`,
      "",
      `Why: ${input.reason}`,
      "",
      forParent
        ? "Nothing else has changed — same session, same educator, same price."
        : "Nothing else has changed — same session, same learner.",
      "",
      `Reference: ${input.reference}`,
      "",
      forParent
        ? "If that time doesn't work after all, reply to this email and a person will pick it up."
        : "If that time doesn't work for you, reply to this email and we'll sort it out.",
      "",
      webUrl(forParent ? "/account/bookings" : "/educator/sessions"),
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent to the parent when the educator on a confirmed session changes.
 *
 * The new name leads: "who is teaching my child on Saturday" is the only
 * question this answers. The previous educator is named to place the change, not
 * to account for it — the reason line does that.
 */
export function bookingReassignedTemplate(input: {
  parentName: string;
  reference: string;
  educatorName: string;
  /** Null only where the booking carried no assignment to begin with. */
  previousEducatorName: string | null;
  when: string;
  reason: string;
}): EmailMessage {
  return {
    to: "",
    subject: `A change of educator · ${input.reference}`,
    text: [
      `Hi ${input.parentName},`,
      "",
      input.previousEducatorName
        ? `${input.educatorName} will now be taking your session on ${input.when}, instead of ${input.previousEducatorName}.`
        : `${input.educatorName} will now be taking your session on ${input.when}.`,
      "",
      `Why: ${input.reason}`,
      "",
      "The time, the session and the price are unchanged.",
      "",
      `Reference: ${input.reference}`,
      "",
      "If you'd rather not go ahead with this educator, reply to this email and a",
      "person will pick it up with you.",
      "",
      webUrl("/account/bookings"),
      "",
      signOff,
    ].join("\n"),
  };
}

/**
 * Sent to the educator a session has been taken away from.
 *
 * Blunt, and first thing in the message: an educator who still believes they are
 * teaching on Saturday is exactly the failure this exists to prevent, and a
 * polite lead-in is what buries it. Carries no learner name and no address, like
 * every other message to an educator (§5/§9).
 */
export function bookingUnassignedTemplate(input: {
  educatorName: string;
  reference: string;
  when: string;
  subjectTopic: string;
  reason: string;
}): EmailMessage {
  return {
    to: "",
    subject: `A session is no longer yours · ${input.reference}`,
    text: [
      `Hi ${input.educatorName},`,
      "",
      `The ${input.subjectTopic} session on ${input.when} has been passed to another`,
      "educator. Please don't attend it.",
      "",
      `Why: ${input.reason}`,
      "",
      "Your other sessions are unaffected:",
      "",
      webUrl("/educator/sessions"),
      "",
      `Reference: ${input.reference}`,
      "",
      signOff,
    ].join("\n"),
  };
}

export function applicationRejectedTemplate(name: string): EmailMessage {
  return {
    to: "",
    subject: `About your application · ${SITE_NAME}`,
    text: [
      `Hi ${name},`,
      "",
      "Thank you for your interest in teaching with us. After reviewing your",
      "application, we're not able to move forward at this time.",
      "",
      "We appreciate the time you took to apply, and we're glad to reconsider a",
      "future application as our subject needs change.",
      "",
      signOff,
    ].join("\n"),
  };
}
