// Why a sign-in was refused, for whoever runs the deployment. Users only ever see
// "Sign-in was refused." Never logs email addresses or tokens: only a reason code, the
// tenant slug (or "operator") and the provider.
import { logEvent } from "@agent-core/core/telemetry";
import { slugProblem } from "@agent-core/db";
import type { EmailLinkRefusal } from "./email-link.ts";
import type { EntraRefusal } from "./entra.ts";
import type { GoogleRefusal } from "./google.ts";
import type { SignInScope } from "./scope.ts";

/** Fixed codes only, so request data can never be passed in as a reason. */
export type RefusalReason =
  | EntraRefusal
  | GoogleRefusal
  | EmailLinkRefusal
  | "no-scope"
  | "unknown-provider"
  | "no-sso-available"
  | "sso-start-failed"
  | "malformed-request"
  | "too-many-links";

export type SignInMethod = "microsoft" | "google" | "email-link" | "unknown";

export function logSignInRefused(
  reason: RefusalReason,
  scope: SignInScope | null,
  method: SignInMethod,
): void {
  // Slugs can come straight from a request: only well-formed ones are written. An event
  // line, so the sign-in-refusals alert matches its name, not free text (review T17).
  const where = !scope
    ? "none"
    : scope.kind === "operator"
      ? "operator"
      : slugProblem(scope.slug) === null
        ? `tenant:${scope.slug}`
        : "tenant:malformed";
  logEvent("sign-in.refused", { reason, where, method }, "warn");
}

/**
 * Errors Auth.js raises itself (before our rules run), for example an expired sign-in.
 * Only the error type is logged: messages can carry request details.
 */
export function logAuthError(error: Error): void {
  console.warn(`sign-in error: ${error.name}`);
}
