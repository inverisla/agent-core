import path from "node:path";
import type { NextConfig } from "next";
import { AUTH_PAGES_POLICY, STATIC_SECURITY_HEADERS } from "./lib/security/headers.ts";

// Settings live in the repo-root .env.local (see .env.example); Next.js only reads
// env files from apps/web, so load the shared one here.
try {
  process.loadEnvFile(path.join(process.cwd(), "../../.env.local"));
} catch {
  // No .env.local: settings come from the environment (CI, Azure).
}

const nextConfig: NextConfig = {
  // The container image builds a standalone server (NEXT_OUTPUT=standalone); local
  // runs and the e2e tests use `next start`, which does not support it.
  ...(process.env["NEXT_OUTPUT"] === "standalone"
    ? { output: "standalone" as const, outputFileTracingRoot: path.join(process.cwd(), "../..") }
    : {}),
  poweredByHeader: false,
  transpilePackages: ["@agent-core/db", "@agent-core/core"],
  serverExternalPackages: ["postgres", "@temporalio/client"],
  experimental: { authInterrupts: true },
  // The Content Security Policy is set per request, with its nonce, in proxy.ts.
  async headers() {
    return [
      { source: "/:path*", headers: STATIC_SECURITY_HEADERS },
      // Answers carry tenant data: never kept by a browser or a proxy (review S16).
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        source: "/api/auth/:path*",
        headers: [{ key: "Content-Security-Policy", value: AUTH_PAGES_POLICY }],
      },
    ];
  },
};

export default nextConfig;
