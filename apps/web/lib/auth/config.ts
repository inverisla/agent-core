import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { db, requireEnv } from "../server/db.ts";
import { redeemEmailLink } from "./email-link.ts";
import { entraIssuer, resolveEntraSignIn, type EntraClaims } from "./entra.ts";
import { resolveGoogleSignIn, type GoogleClaims } from "./google.ts";
import { currentIdentity, TENANT_SESSION_MS } from "./identity.ts";
import { logAuthError, logSignInRefused, type SignInMethod } from "./log.ts";
import type { SignInScope } from "./scope.ts";
import {
  LOCAL_OPERATOR_PROVIDER_ID,
  localOperatorAllowedHere,
  localOperatorEnabled,
  localOperatorIdentity,
} from "./local-operator.ts";
import { ENTRA_PROVIDER_ID, GOOGLE_PROVIDER_ID, ssoTargetFor } from "./sso.ts";

export { ENTRA_PROVIDER_ID, GOOGLE_PROVIDER_ID };

/** The AUTH_SECRET in .env.example. Public, so refused anywhere but localhost. */
export const LOCAL_DEV_AUTH_SECRET = "local-dev-only-auth-secret-do-not-use-in-azure-0001";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const EMAIL_LINK_PROVIDER_ID = "email-link";

/** Where to send someone whose sign-in was refused. Same page whatever the reason. */
function refusedUrl(scope: SignInScope | null): string {
  return scope?.kind === "tenant"
    ? `/t/${scope.slug}/sign-in?error=refused`
    : "/operator/sign-in?error=refused";
}

export async function buildAuthConfig(scope: SignInScope | null): Promise<NextAuthConfig> {
  const secret = requireEnv("AUTH_SECRET");
  const authUrl = new URL(requireEnv("AUTH_URL"));
  if (secret === LOCAL_DEV_AUTH_SECRET && !LOCAL_HOSTS.has(authUrl.hostname)) {
    throw new Error(
      "AUTH_SECRET is the public development value from .env.example; set a real one.",
    );
  }

  // SSO goes to one place only: the client's Microsoft organisation for operators, or
  // the provider a tenant has linked. Microsoft uses that organisation's own Entra
  // endpoint, so Auth.js's issuer check only passes for it. Only resolved while a
  // sign-in is starting or completing (scope is null otherwise), so ordinary requests
  // make no lookup.
  const target = scope ? await ssoTargetFor(scope) : null;

  return {
    secret,
    trustHost: true,
    session: { strategy: "jwt", maxAge: TENANT_SESSION_MS / 1000 },
    pages: { signIn: "/operator/sign-in", error: "/sign-in/error" },
    logger: { error: logAuthError },
    providers: [
      ...(target?.provider === "microsoft"
        ? [
            MicrosoftEntraID({
              clientId: requireEnv("AUTH_MICROSOFT_ENTRA_ID_ID"),
              clientSecret: requireEnv("AUTH_MICROSOFT_ENTRA_ID_SECRET"),
              issuer: entraIssuer(target.entraTenantId),
              // Always the account picker: otherwise Microsoft reuses whichever account the
              // browser last signed in with, and someone who chose the wrong one first is
              // refused on every later try.
              authorization: {
                params: { scope: "openid profile email", prompt: "select_account" },
              },
              // No Microsoft Graph call for a photo; identity comes from the ID token.
              profile: (p) => ({ id: String(p["oid"]), name: p.name, email: p.email ?? null }),
            }),
          ]
        : []),
      ...(target?.provider === "google"
        ? [
            Google({
              clientId: requireEnv("AUTH_GOOGLE_ID"),
              clientSecret: requireEnv("AUTH_GOOGLE_SECRET"),
              // No hd parameter: it would only steer Google's account picker, and would put
              // the tenant's domain in the redirect URL. The domain is enforced after
              // sign-in by resolveGoogleSignIn.
              authorization: {
                params: {
                  scope: "openid email profile",
                  prompt: "select_account",
                },
              },
            }),
          ]
        : []),
      Credentials({
        id: EMAIL_LINK_PROVIDER_ID,
        credentials: { slug: {}, email: {}, token: {} },
        async authorize(credentials) {
          const { slug, email, token } = credentials as Record<string, unknown>;
          if (typeof slug !== "string" || typeof email !== "string" || typeof token !== "string") {
            logSignInRefused("malformed-request", null, "email-link");
            return null;
          }
          const result = await redeemEmailLink(db(), { slug, email, token });
          if (!result.ok) {
            logSignInRefused(result.reason, { kind: "tenant", slug }, "email-link");
            return null;
          }
          return { id: result.identity.userId, identity: result.identity };
        },
      }),
      // The demo's local operator (task 15): only on this machine, when asked for.
      ...(localOperatorEnabled()
        ? [
            Credentials({
              id: LOCAL_OPERATOR_PROVIDER_ID,
              credentials: {},
              async authorize() {
                if (!(await localOperatorAllowedHere())) return null;
                const identity = localOperatorIdentity();
                return { id: identity.oid, identity };
              },
            }),
          ]
        : []),
    ],
    callbacks: {
      async signIn({ user, account, profile }) {
        if (account?.provider === EMAIL_LINK_PROVIDER_ID) return Boolean(user.identity);
        if (account?.provider === LOCAL_OPERATOR_PROVIDER_ID) {
          return Boolean(user.identity) && (await localOperatorAllowedHere());
        }
        const method: SignInMethod =
          account?.provider === ENTRA_PROVIDER_ID
            ? "microsoft"
            : account?.provider === GOOGLE_PROVIDER_ID
              ? "google"
              : "unknown";
        if (!scope || method === "unknown") {
          logSignInRefused(!scope ? "no-scope" : "unknown-provider", scope, method);
          return refusedUrl(scope);
        }
        const result =
          method === "microsoft"
            ? await resolveEntraSignIn(scope, (profile ?? {}) as EntraClaims, {
                db: db(),
                operatorEntraTenantId: process.env["OPERATOR_ENTRA_TENANT_ID"],
              })
            : await resolveGoogleSignIn(scope, (profile ?? {}) as GoogleClaims, { db: db() });
        if (!result.ok) {
          logSignInRefused(result.reason, scope, method);
          return refusedUrl(scope);
        }
        user.identity = result.identity;
        return true;
      },
      jwt({ token, user }) {
        if (user?.identity) token.identity = user.identity;
        return token;
      },
      session({ session, token }) {
        const identity = currentIdentity(token.identity);
        if (identity) session.identity = identity;
        return session;
      },
    },
  };
}
