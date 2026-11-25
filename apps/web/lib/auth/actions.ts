"use server";

import { AuthError } from "next-auth";
import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { logEvent } from "@agent-core/core/telemetry";
import { endUserSessions, slugProblem } from "@agent-core/db";
import { tenantActor } from "./actors.ts";
import { checkTenant, signedInIdentity } from "./guards.ts";
import { signIn, signOut } from "../../auth.ts";
import { sendEmail } from "../email/send.ts";
import { db, requireEnv } from "../server/db.ts";
import { EMAIL_LINK_PROVIDER_ID } from "./config.ts";
import { createEmailLink } from "./email-link.ts";
import { LOCAL_OPERATOR_PROVIDER_ID, localOperatorAllowedHere } from "./local-operator.ts";
import { SCOPE_COOKIE, scopeToCookie, type SignInScope } from "./scope.ts";
import { logSignInRefused } from "./log.ts";
import { signInContext } from "./sign-in-context.ts";
import { providerIdFor, ssoTargetFor } from "./sso.ts";

async function setScope(scope: SignInScope) {
  (await cookies()).set(SCOPE_COOKIE, scopeToCookie(scope), {
    httpOnly: true,
    sameSite: "lax",
    secure: requireEnv("AUTH_URL").startsWith("https:"),
    path: "/",
    maxAge: 15 * 60,
  });
}

async function startSso(scope: SignInScope, redirectTo: string, refused: string) {
  // Decided here, before Auth.js is involved: unknown slug, nothing linked and a
  // provider that is not configured all get the same refusal page, with no redirect
  // elsewhere.
  const target = await ssoTargetFor(scope);
  if (!target) {
    // Unknown tenant, nothing linked, or the linked provider is not configured here.
    logSignInRefused("no-sso-available", scope, "unknown");
    redirect(refused);
  }
  await setScope(scope);
  try {
    await signInContext.run(scope, () => signIn(providerIdFor(target), { redirectTo }));
  } catch (error) {
    unstable_rethrow(error);
    logSignInRefused("sso-start-failed", scope, target.provider);
    redirect(refused);
  }
}

export async function startOperatorMicrosoftSignIn() {
  await startSso({ kind: "operator" }, "/operator", "/operator/sign-in?error=refused");
}

/** The demo's local operator (task 15); refused unless allowed on this machine. */
export async function startLocalOperatorSignIn() {
  if (!(await localOperatorAllowedHere())) redirect("/operator/sign-in?error=refused");
  await signIn(LOCAL_OPERATOR_PROVIDER_ID, { redirectTo: "/operator" });
}

/** "Sign in with your work account": the tenant's linked Microsoft or Google SSO. */
export async function startTenantSsoSignIn(slug: string) {
  const refused = `/t/${encodeURIComponent(slug)}/sign-in?error=refused`;
  if (slugProblem(slug) !== null) {
    logSignInRefused("malformed-request", null, "unknown");
    redirect(refused);
  }
  await startSso({ kind: "tenant", slug }, `/t/${slug}`, refused);
}

/**
 * Sends a sign-in link if the address belongs to a user of this tenant. Responds the
 * same way, and as quickly, whether or not it does: the work runs after the response.
 */
export async function requestEmailLink(slug: string, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  if (slugProblem(slug) === null) {
    const baseUrl = requireEnv("AUTH_URL");
    after(async () => {
      try {
        await sendSignInEmail(slug, email, baseUrl);
      } catch (error) {
        // The person already saw "we have sent a link": log the failure (never the address).
        logEvent(
          "email.failed",
          { kind: "sign-in", error: error instanceof Error ? error.name : "unknown" },
          "error",
        );
      }
    });
  }
  redirect(`/t/${encodeURIComponent(slug)}/sign-in?sent=1`);
}

/** The sign-in link, or a note to use their work account; nothing for an unknown address. */
async function sendSignInEmail(slug: string, email: string, baseUrl: string) {
  const outcome = await createEmailLink(db(), { slug, email, baseUrl });
  if (outcome?.kind === "link") {
    await sendEmail({
      to: outcome.to,
      subject: "Your sign-in link",
      text: `Use this link to sign in. It works once and expires in 15 minutes.\n\n${outcome.url}\n\nIf you did not ask for it, you can ignore this email.`,
    });
  } else if (outcome?.kind === "use-sso") {
    await sendEmail({
      to: outcome.to,
      subject: "How to sign in",
      text: `This portal no longer sends sign-in links. Sign in with your work account instead:\n\n${new URL(`/t/${slug}/sign-in`, baseUrl).toString()}\n\nChoose "Sign in with your work account". If you did not ask to sign in, you can ignore this email.`,
    });
  }
}

export async function signInWithEmailLink(slug: string, email: string, token: string) {
  try {
    await signIn(EMAIL_LINK_PROVIDER_ID, { slug, email, token, redirectTo: `/t/${slug}` });
  } catch (error) {
    if (error instanceof AuthError) redirect(`/t/${encodeURIComponent(slug)}/sign-in?error=link`);
    throw error;
  }
}

export async function signOutTo(path: string) {
  // A tenant user is signed out everywhere, so a copied session cookie stops working too
  // (review S15). Operator sessions are not recorded anywhere to end; they last at most
  // an hour (docs/architecture.md).
  // If the database cannot be reached, the cookie is still cleared.
  try {
    const identity = await signedInIdentity();
    if (identity?.kind === "tenant") {
      const access = await checkTenant(identity.slug);
      if (access.ok) {
        const actor = tenantActor(access.value);
        if (actor.kind === "user") await endUserSessions(db(), access.value.tenantId, actor);
      }
    }
  } catch (error) {
    console.error(
      `sessions not ended at sign-out: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  await signOut({ redirectTo: path });
}
