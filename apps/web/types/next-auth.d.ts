import type { Identity } from "../lib/auth/identity.ts";

declare module "next-auth" {
  interface Session {
    identity?: Identity;
  }
  interface User {
    identity?: Identity;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    identity?: Identity;
  }
}
