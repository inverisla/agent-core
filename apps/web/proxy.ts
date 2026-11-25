import { NextResponse, type NextRequest } from "next/server";
import { auth } from "./auth.ts";
import { currentIdentity } from "./lib/auth/identity.ts";
import { contentSecurityPolicy, strictTransportSecurity } from "./lib/security/headers.ts";

// Two jobs. Every page gets a Content Security Policy with a fresh nonce, which Next.js
// puts on its own scripts (lib/security/headers.ts). And people with no session are sent
// to the right sign-in page: only a first line, since every page and API route checks
// access itself (lib/auth/guards.ts), so nothing depends on it.
export async function proxy(req: NextRequest): Promise<NextResponse> {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env["NODE_ENV"] !== "production");
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  // Read at run time: the address is the deployment's, not the build's.
  const hsts = strictTransportSecurity(process.env["AUTH_URL"]);
  const withCsp = (res: NextResponse) => {
    res.headers.set("Content-Security-Policy", csp);
    if (hsts) res.headers.set("Strict-Transport-Security", hsts);
    return res;
  };

  const path = req.nextUrl.pathname;
  const isProtected = /^\/(operator|t)(\/|$)/.test(path);
  const isSignIn =
    /^\/operator\/sign-in(\/|$)/.test(path) || /^\/t\/[^/]+\/sign-in(\/|$)/.test(path);
  if (isProtected && !isSignIn) {
    const session = await auth();
    if (!currentIdentity(session?.identity)) {
      const tenant = /^\/t\/([^/]+)/.exec(path);
      const target = tenant ? `/t/${tenant[1]}/sign-in` : "/operator/sign-in";
      return withCsp(NextResponse.redirect(new URL(target, req.nextUrl)));
    }
  }
  return withCsp(NextResponse.next({ request: { headers } }));
}

// Every page, not the API (JSON, checked by its own guards; passing request headers on
// here would make Next.js read a whole upload before the route can refuse it), nor
// Next.js's own static files or the stylesheet routes. next.config.ts still adds the
// static security headers to everything.
export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|logo.svg|theme.css).*)"],
};
