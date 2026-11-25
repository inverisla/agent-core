// The email someone gets when they are added to a tenant's portal (task 12b): where to
// sign in. No sign-in link: they ask for one, or use their work account, on that page.
import { normaliseEmail, type TenantDatabase } from "@agent-core/db";
import { after } from "next/server";
import { logEvent } from "@agent-core/core/telemetry";
import { claimEmailSend } from "../auth/email-link.ts";
import { theme } from "../../theme.ts";
import { sendEmail } from "./send.ts";

type WelcomeInput = Parameters<typeof sendWelcome>[0];

/**
 * Sends the welcome email after the response (a mail fault never fails the change), if
 * the address is within the sending limits (review S14: otherwise adding, removing and
 * adding someone again would send them any number). False if it was not sent.
 */
export async function welcomeWithinLimits(
  db: TenantDatabase,
  tenantId: string,
  input: WelcomeInput,
): Promise<boolean> {
  const email = normaliseEmail(input.to);
  if (!email) return false;
  // The change itself is already saved: a fault here means no email, never a failed change.
  let allowed = false;
  try {
    allowed = await db.withTenant(tenantId, (tx) => claimEmailSend(tx, tenantId, email));
  } catch (error) {
    console.error(`welcome email not sent: ${error instanceof Error ? error.name : "unknown"}`);
  }
  if (!allowed) return false;
  after(() =>
    sendWelcome(input).catch((error: unknown) => {
      // The email-failed alert watches for this (never with the address).
      logEvent(
        "email.failed",
        { kind: "welcome", error: error instanceof Error ? error.name : "unknown" },
        "error",
      );
    }),
  );
  return true;
}

export async function sendWelcome(input: {
  to: string;
  slug: string;
  tenantName: string;
  role: "tenant_admin" | "tenant_user";
}): Promise<void> {
  const baseUrl = process.env["AUTH_URL"];
  if (!baseUrl) throw new Error("AUTH_URL is not set.");
  const url = new URL(`/t/${encodeURIComponent(input.slug)}/sign-in`, baseUrl).toString();
  const as = input.role === "tenant_admin" ? "an admin" : "a user";
  await sendEmail({
    to: input.to,
    subject: `You have been added to ${theme.productName}`,
    text:
      `You have been added to ${input.tenantName}'s portal on ${theme.productName}, as ${as}.\n\n` +
      `Sign in here:\n\n${url}\n\n` +
      "If you were not expecting this, you can ignore this email.",
  });
}
