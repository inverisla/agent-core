import { PublicShell } from "../../../../components/shells.tsx";
import {
  Alert,
  Button,
  Card,
  Field,
  FormStack,
  PageHeader,
} from "../../../../components/ui/index.ts";
import { requestEmailLink, startTenantSsoSignIn } from "../../../../lib/auth/actions.ts";
import { tenantSsoAvailable } from "../../../../lib/auth/sso.ts";

// The browser tab's title (WCAG 2.4.2): "Sign in · <product name>".
export const metadata = { title: "Sign in" };

// Looks the same whether or not the slug belongs to a tenant, and never shows the
// tenant's name. Starting a work-account sign-in from it does tell a visitor whether the
// slug has SSO linked, and with Microsoft the tenant's Entra directory ID (the redirect
// goes to that directory). Accepted (review S13): the slug is in the portal's address
// already, and a directory ID can be looked up from the organisation's domain anyway.
export default async function TenantSignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { slug } = await params;
  const { sent, error } = await searchParams;
  return (
    <PublicShell homeHref={`/t/${slug}/sign-in`}>
      <PageHeader title="Sign in" />
      {sent ? (
        <Alert tone="success">
          If that address belongs to a user of this portal, we have sent a sign-in link. It expires
          in 15 minutes.
        </Alert>
      ) : null}
      {error === "link" ? (
        <Alert tone="danger">That sign-in link is not valid. Ask for a new one.</Alert>
      ) : null}
      {error === "refused" ? <Alert tone="danger">Sign-in was refused.</Alert> : null}
      {tenantSsoAvailable() ? (
        <Card>
          <form action={startTenantSsoSignIn.bind(null, slug)}>
            <Button>Sign in with your work account</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Sign in with an email link">
        <form action={requestEmailLink.bind(null, slug)}>
          <FormStack>
            <Field label="Email address" type="email" name="email" required autoComplete="email" />
            <div>
              <Button variant={tenantSsoAvailable() ? "secondary" : "primary"}>
                Email me a sign-in link
              </Button>
            </div>
          </FormStack>
        </form>
      </Card>
    </PublicShell>
  );
}
