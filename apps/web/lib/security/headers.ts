// The web app's security headers (review S2). Every tenant's portal and the operator
// console share one origin, so these are the second line of defence after React's
// escaping. The policy allows scripts only with the request's nonce (Next.js adds it to
// its own scripts) and styles, images and fonts from this app only; forms may post to the
// sign-in providers, since Auth.js answers a sign-in form with a redirect to them.

/** Where sign-in forms may lead (a form's redirect counts under form-action). */
const SIGN_IN_PROVIDERS = ["https://login.microsoftonline.com", "https://accounts.google.com"];

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next.js's nonced scripts load its chunks; development adds
    // eval for fast refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    // Production pages have no inline styles (the theme is /theme.css). Next.js's
    // development overlay adds unnonced styles in a shadow root, so development allows
    // inline styles (a nonce would make browsers ignore 'unsafe-inline').
    development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${SIGN_IN_PROVIDERS.join(" ")}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The same on every response, pages and files alike (next.config.ts). */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Sign-in links carry a token in their address: never send it on to another site.
  // (Not no-referrer: that makes browsers send "Origin: null" on the app's own form
  // posts, which the upload's origin check then refuses.)
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/**
 * For Auth.js's own pages under /api/auth (sign-out confirmation, errors), which proxy.ts
 * does not see: they have inline styles and no scripts.
 */
export const AUTH_PAGES_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * HSTS only for a real https address: on http://localhost a browser would ignore it, but
 * sent from a test address on https it would pin that host to https for a year.
 */
export function strictTransportSecurity(authUrl: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(authUrl ?? "");
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" && !local ? "max-age=31536000; includeSubDomains" : null;
}
