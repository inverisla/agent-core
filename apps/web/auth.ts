import NextAuth from "next-auth";
import { buildAuthConfig } from "./lib/auth/config.ts";
import { SCOPE_COOKIE, scopeFromCookie } from "./lib/auth/scope.ts";
import { signInContext } from "./lib/auth/sign-in-context.ts";

// The config is built per request so that Microsoft sign-in can target the right
// organisation (see lib/auth/config.ts). The sign-in scope matters only on the Auth.js
// sign-in and callback routes, or inside the server action that starts a sign-in.
const SIGN_IN_ROUTES = /^\/api\/auth\/(signin|callback)\//;

export const { handlers, auth, signIn, signOut } = NextAuth(async (req) => {
  const scope = req
    ? SIGN_IN_ROUTES.test(req.nextUrl.pathname)
      ? scopeFromCookie(req.cookies.get(SCOPE_COOKIE)?.value)
      : null
    : (signInContext.getStore() ?? null);
  return buildAuthConfig(scope);
});
