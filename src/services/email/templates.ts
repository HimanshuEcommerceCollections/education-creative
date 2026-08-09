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
