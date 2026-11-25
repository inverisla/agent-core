import { getTenantSso } from "@agent-core/db";
import { PortalShell } from "../../../../../../components/shells.tsx";
import { Alert, Button, Card, PageHeader } from "../../../../../../components/ui/index.ts";
import { canTurnOffEmailLinks } from "../../../../../../lib/auth/email-link-switch.ts";
import { requireTenantPage } from "../../../../../../lib/auth/guards.ts";
import { setEmailLinks } from "../../../../../../lib/auth/settings-actions.ts";
import { db } from "../../../../../../lib/server/db.ts";

// The browser tab's title (WCAG 2.4.2): "Sign-in settings · <product name>".
export const metadata = { title: "Sign-in settings" };

export default async function SignInSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { slug } = await params;
  const { saved, error } = await searchParams;
  const me = await requireTenantPage(slug, { admin: true });
  const sso = await getTenantSso(db(), me.tenantId);
  const switchOff = sso.allowEmailLinks && sso.link ? await canTurnOffEmailLinks(me) : null;
  const linked = sso.link
    ? sso.link.provider === "google"
      ? `Google Workspace (${sso.link.googleDomain})`
      : "Microsoft (Entra ID)"
    : null;

  return (
    <PortalShell slug={slug} me={me} current="admin" inside>
      <PageHeader title="Sign-in settings" />
      {saved ? <Alert tone="success">Saved.</Alert> : null}
      {error === "sso-not-available" ? (
        <Alert tone="danger">
          Work account sign-in is not available, so email links must stay on.
        </Alert>
      ) : null}
      {error === "sign-in-with-sso-first" ? (
        <Alert tone="danger">
          Sign in once with your work account before turning off email links.
        </Alert>
      ) : null}
      <Card title="Work account sign-in">
        <p>{linked ?? "Not linked. Ask the portal's operator to link Microsoft or Google."}</p>
      </Card>
      <Card title="Email sign-in links">
        <p>Email sign-in links are {sso.allowEmailLinks ? "on" : "off"}.</p>
        {sso.allowEmailLinks && !sso.link ? (
          <p className="text-muted" data-testid="email-links-why">
            You can turn them off once work account sign-in is linked and you have signed in with it
            once, so that nobody is locked out. Until then they stay on.
          </p>
        ) : null}
        {switchOff?.ok === false ? (
          <p className="text-muted">
            {switchOff.reason === "sign-in-with-sso-first"
              ? "To turn email links off, first sign out and sign in once with your work account. That makes sure at least one admin can still get in."
              : "Work account sign-in is not available on this portal yet, so email links must stay on."}
          </p>
        ) : null}
        {switchOff?.ok ? (
          <form action={setEmailLinks.bind(null, slug, false)} className="space-y-3">
            <p>Turn them off to make everyone sign in with their work account.</p>
            <Button variant="danger">Turn off email links</Button>
          </form>
        ) : null}
        {!sso.allowEmailLinks ? (
          <form action={setEmailLinks.bind(null, slug, true)}>
            <Button>Turn on email links</Button>
          </form>
        ) : null}
      </Card>
    </PortalShell>
  );
}
