// The personas and routes of the role matrix, shared by the access tests (task 3) and
// the accessibility and phone-width checks (task 10b), so both cover the same pages.
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/auth/identity.ts";
import { sessionCookie } from "./sessions.ts";
import { readState } from "./state.ts";

export const state = readState();
const { a, b } = state;
const later = () => Date.now() + 60 * 60 * 1000;

const tenantIdentity = (
  t: typeof a | typeof b,
  userId: string,
  role: "tenant_admin" | "tenant_user",
): Identity => ({
  kind: "tenant",
  tenantId: t.tenantId,
  slug: t.slug,
  userId,
  role,
  expiresAt: later(),
});

export type PersonaName =
  | "anonymous"
  | "operator"
  | "adminA"
  | "userA"
  | "adminB"
  | "userB"
  | "expiredOperator"
  | "removedUserA"
  | "forgedAdminA"
  | "elevatedUserA"
  | "crossTenantUserA";

// Cookies for each persona. The last three must be treated as not signed in.
export const personas: Record<PersonaName, () => Promise<string | null>> = {
  anonymous: async () => null,
  operator: () =>
    sessionCookie(
      { kind: "operator", oid: randomUUID(), name: "Op", email: null, expiresAt: later() },
      state.authSecret,
    ),
  adminA: () => sessionCookie(tenantIdentity(a, a.admin.userId, "tenant_admin"), state.authSecret),
  userA: () => sessionCookie(tenantIdentity(a, a.user.userId, "tenant_user"), state.authSecret),
  adminB: () => sessionCookie(tenantIdentity(b, b.admin.userId, "tenant_admin"), state.authSecret),
  userB: () => sessionCookie(tenantIdentity(b, b.user.userId, "tenant_user"), state.authSecret),
  expiredOperator: () =>
    sessionCookie(
      {
        kind: "operator",
        oid: randomUUID(),
        name: "Op",
        email: null,
        expiresAt: Date.now() - 1000,
      },
      state.authSecret,
    ),
  removedUserA: () =>
    sessionCookie(tenantIdentity(a, a.removed.userId, "tenant_user"), state.authSecret),
  forgedAdminA: () =>
    sessionCookie(
      tenantIdentity(a, a.admin.userId, "tenant_admin"),
      "not-the-real-secret-not-the-real-secret",
    ),
  // Session says admin, database says user: the database wins.
  elevatedUserA: () =>
    sessionCookie(tenantIdentity(a, a.user.userId, "tenant_admin"), state.authSecret),
  // Session says tenant A but carries a tenant B user: no such user in A.
  crossTenantUserA: () =>
    sessionCookie(tenantIdentity(a, b.user.userId, "tenant_admin"), state.authSecret),
};
export const notSignedIn = new Set<PersonaName>(["anonymous", "expiredOperator", "forgedAdminA"]);

export interface Route {
  path: string;
  api: boolean;
  allowed: PersonaName[];
  signIn: string;
}
export const routes: Route[] = [
  { path: "/operator", api: false, allowed: ["operator"], signIn: "/operator/sign-in" },
  { path: "/api/operator/me", api: true, allowed: ["operator"], signIn: "" },
  { path: "/operator/tenants/new", api: false, allowed: ["operator"], signIn: "/operator/sign-in" },
  {
    path: `/operator/tenants/${a.tenantId}`,
    api: false,
    allowed: ["operator"],
    signIn: "/operator/sign-in",
  },
  { path: "/operator/usage", api: false, allowed: ["operator"], signIn: "/operator/sign-in" },
  { path: "/operator/agents", api: false, allowed: ["operator"], signIn: "/operator/sign-in" },
  {
    path: "/operator/agents/contract-summary",
    api: false,
    allowed: ["operator"],
    signIn: "/operator/sign-in",
  },
  { path: "/operator/jobs", api: false, allowed: ["operator"], signIn: "/operator/sign-in" },
  {
    path: `/operator/jobs?job=${state.aJobId}`,
    api: false,
    allowed: ["operator"],
    signIn: "/operator/sign-in",
  },
  { path: "/api/operator/usage", api: true, allowed: ["operator"], signIn: "" },
  {
    path: `/api/operator/tenants/${a.tenantId}/audit`,
    api: true,
    allowed: ["operator"],
    signIn: "",
  },
  {
    path: `/t/${a.slug}/admin/activity`,
    api: false,
    allowed: ["adminA"],
    signIn: `/t/${a.slug}/sign-in`,
  },
  { path: `/api/t/${a.slug}/admin/audit`, api: true, allowed: ["adminA"], signIn: "" },
  {
    path: `/t/${a.slug}/admin/users`,
    api: false,
    allowed: ["adminA"],
    signIn: `/t/${a.slug}/sign-in`,
  },
  {
    path: `/t/${a.slug}`,
    api: false,
    allowed: ["adminA", "userA", "elevatedUserA"],
    signIn: `/t/${a.slug}/sign-in`,
  },
  { path: `/t/${a.slug}/admin`, api: false, allowed: ["adminA"], signIn: `/t/${a.slug}/sign-in` },
  {
    path: `/t/${a.slug}/documents`,
    api: false,
    allowed: ["adminA", "userA", "elevatedUserA"],
    signIn: `/t/${a.slug}/sign-in`,
  },
  {
    path: `/api/t/${a.slug}/documents`,
    api: true,
    allowed: ["adminA", "userA", "elevatedUserA"],
    signIn: "",
  },
  {
    path: `/t/${a.slug}/jobs/${state.aJobId}`,
    api: false,
    allowed: ["adminA", "userA", "elevatedUserA"],
    signIn: `/t/${a.slug}/sign-in`,
  },
  {
    path: `/api/t/${a.slug}/jobs/${state.aJobId}`,
    api: true,
    allowed: ["adminA", "userA", "elevatedUserA"],
    signIn: "",
  },
  {
    path: `/api/t/${a.slug}/jobs/${state.aJobId}/report`,
    api: true,
    allowed: ["adminA", "userA", "elevatedUserA"],
    signIn: "",
  },
  {
    path: `/t/${a.slug}/admin/sign-in`,
    api: false,
    allowed: ["adminA"],
    signIn: `/t/${a.slug}/sign-in`,
  },
  {
    path: `/api/t/${a.slug}/me`,
    api: true,
    allowed: ["adminA", "userA", "elevatedUserA"],
    signIn: "",
  },
  { path: `/api/t/${a.slug}/admin/me`, api: true, allowed: ["adminA"], signIn: "" },
  {
    path: `/t/${b.slug}`,
    api: false,
    allowed: ["adminB", "userB"],
    signIn: `/t/${b.slug}/sign-in`,
  },
  { path: `/t/${b.slug}/admin`, api: false, allowed: ["adminB"], signIn: `/t/${b.slug}/sign-in` },
  { path: `/api/t/${b.slug}/me`, api: true, allowed: ["adminB", "userB"], signIn: "" },
  { path: `/api/t/${b.slug}/admin/me`, api: true, allowed: ["adminB"], signIn: "" },
  { path: "/t/no-such-tenant", api: false, allowed: [], signIn: "/t/no-such-tenant/sign-in" },
  { path: "/api/t/no-such-tenant/me", api: true, allowed: [], signIn: "" },
];
