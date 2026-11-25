import { PublicShell } from "../../../components/shells.tsx";
import { Alert, Button, Card, PageHeader } from "../../../components/ui/index.ts";
import {
  startLocalOperatorSignIn,
  startOperatorMicrosoftSignIn,
} from "../../../lib/auth/actions.ts";
import { localOperatorAllowedHere } from "../../../lib/auth/local-operator.ts";
import { entraConfigured } from "../../../lib/auth/sso.ts";

// The browser tab's title (WCAG 2.4.2): "Operator sign-in · <product name>".
export const metadata = { title: "Operator sign-in" };

export default async function OperatorSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <PublicShell>
      <PageHeader title="Operator sign-in" />
      {error ? <Alert tone="danger">Sign-in was refused.</Alert> : null}
      <Card>
        {entraConfigured() ? (
          <form action={startOperatorMicrosoftSignIn}>
            <Button>Sign in with Microsoft</Button>
          </form>
        ) : (
          <p>Microsoft sign-in is not configured for this deployment.</p>
        )}
      </Card>
      {(await localOperatorAllowedHere()) ? (
        <Card title="On this machine only">
          <p className="text-sm text-muted">
            For trying the demo: DEV_OPERATOR_SIGN_IN is on and this is a local address. It never
            works on a deployment.
          </p>
          <form action={startLocalOperatorSignIn}>
            <Button variant="secondary">Sign in as the local operator</Button>
          </form>
        </Card>
      ) : null}
    </PublicShell>
  );
}
