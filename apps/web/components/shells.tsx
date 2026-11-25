// The frame for each area of the app, built on AppShell.
import type { ReactNode } from "react";
import { signOutTo } from "../lib/auth/actions.ts";
import { AppShell } from "./ui/index.ts";

/** Pages for people who are not signed in: sign-in, errors, the landing page. */
export function PublicShell({
  homeHref = "/",
  children,
}: {
  homeHref?: string;
  children: ReactNode;
}) {
  return <AppShell homeHref={homeHref}>{children}</AppShell>;
}

export type PortalPage = "home" | "documents" | "admin";

/** The tenant portal, for a signed-in tenant user or admin. */
export function PortalShell({
  slug,
  me,
  current,
  inside = false,
  children,
}: {
  slug: string;
  me: { displayName: string; role: string };
  current?: PortalPage;
  /** On a page inside that section (a job, inside Documents), not the section's own page. */
  inside?: boolean;
  children: ReactNode;
}) {
  const base = `/t/${slug}`;
  const nav = [
    { href: `${base}/documents`, label: "Documents", current: current === "documents", inside },
    ...(me.role === "tenant_admin"
      ? [{ href: `${base}/admin`, label: "Admin", current: current === "admin", inside }]
      : []),
  ];
  return (
    <AppShell
      homeHref={base}
      nav={nav}
      user={me.displayName}
      signOut={signOutTo.bind(null, `${base}/sign-in`)}
    >
      {children}
    </AppShell>
  );
}

/** The operator console, for the client's own staff. */
export function OperatorShell({
  name,
  current = "tenants",
  inside = false,
  children,
}: {
  name: string;
  current?: "tenants" | "agents" | "jobs" | "usage";
  /** On a page inside the current section (a tenant, the new-tenant form), not its front page. */
  inside?: boolean;
  children: ReactNode;
}) {
  return (
    <AppShell
      homeHref="/operator"
      area="Operator console"
      nav={[
        { href: "/operator", label: "Tenants", current: current === "tenants", inside },
        { href: "/operator/agents", label: "Agents", current: current === "agents", inside },
        { href: "/operator/jobs", label: "Jobs", current: current === "jobs", inside },
        { href: "/operator/usage", label: "Usage", current: current === "usage", inside },
      ]}
      user={name}
      signOut={signOutTo.bind(null, "/operator/sign-in")}
    >
      {children}
    </AppShell>
  );
}
