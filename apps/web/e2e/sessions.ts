import { encode } from "next-auth/jwt";
import type { Identity } from "../lib/auth/identity.ts";
import { BASE_URL } from "./state.ts";

// Real Auth.js session cookies, encrypted with this run's AUTH_SECRET. The app has no
// test-only way in: these are exactly what a successful sign-in sets.
export const SESSION_COOKIE = "authjs.session-token";

export async function sessionCookie(identity: Identity, secret: string): Promise<string> {
  const value = await encode({
    token: { sub: identity.kind === "operator" ? identity.oid : identity.userId, identity },
    secret,
    salt: SESSION_COOKIE,
    maxAge: 8 * 60 * 60,
  });
  return `${SESSION_COOKIE}=${value}`;
}

export const cookieDomain = new URL(BASE_URL).hostname;
