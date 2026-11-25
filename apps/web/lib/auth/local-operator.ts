// A local operator sign-in for the demo (task 15). The operator console otherwise needs a
// Microsoft organisation and an Entra app registration, which someone trying the demo
// will not have. Allowed only when DEV_OPERATOR_SIGN_IN is "true", AUTH_URL is this
// machine, the app is on a developer's machine (notLocalReason: no hosting platform, a
// local database and Temporal), and the request
// itself was addressed to this machine (its Host header), so a web page that points its
// own domain at 127.0.0.1 (DNS rebinding) cannot use it. `pnpm dev` also listens on
// 127.0.0.1 only, and so does `pnpm start` (review S8), so nobody else on the network can
// reach it. Refused everywhere else,
// and a session made with it stops working as soon as it is no longer allowed.
import { isLocalAddress, notLocalReason } from "@agent-core/core/local";
import type { OperatorIdentity } from "./identity.ts";
import { OPERATOR_SESSION_MS } from "./identity.ts";

export const LOCAL_OPERATOR_PROVIDER_ID = "local-operator";
/** The operator's ID in sessions and the audit log. Never a real Entra object ID. */
export const LOCAL_OPERATOR_OID = "local-operator";

/** Whether this app is set up for the local operator sign-in at all. */
export function localOperatorEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env["DEV_OPERATOR_SIGN_IN"] !== "true") return false;
  return isLocalAddress(env["AUTH_URL"] ?? "") && notLocalReason(env) === null;
}

/**
 * Whether the local operator sign-in is allowed for a request whose Host header is
 * `host` (null: no request, never allowed).
 */
export function localOperatorAllowed(
  host: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return localOperatorEnabled(env) && host !== null && isLocalAddress(`http://${host}`);
}

/** The same, for the request being handled (pages, server actions, route handlers). */
export async function localOperatorAllowedHere(): Promise<boolean> {
  const { headers } = await import("next/headers");
  return localOperatorAllowed((await headers()).get("host"));
}

export function localOperatorIdentity(now = Date.now()): OperatorIdentity {
  return {
    kind: "operator",
    oid: LOCAL_OPERATOR_OID,
    name: "Local operator",
    email: null,
    expiresAt: now + OPERATOR_SESSION_MS,
  };
}
