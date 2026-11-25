import { PublicShell } from "../../../../../components/shells.tsx";
import { Button, Card, PageHeader } from "../../../../../components/ui/index.ts";
import { signInWithEmailLink } from "../../../../../lib/auth/actions.ts";

// The browser tab's title (WCAG 2.4.2): "Confirm sign-in · <product name>".
export const metadata = { title: "Confirm sign-in" };

// Opening the link does not sign in: the button does. Email security scanners that
// open links therefore cannot use up the single-use token.
export default async function VerifyEmailLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ email?: string; token?: string }>;
}) {
  const { slug } = await params;
  const { email = "", token = "" } = await searchParams;
  return (
    <PublicShell homeHref={`/t/${slug}/sign-in`}>
      <PageHeader title="Sign in" />
      <Card>
        <p>Continue as {email}?</p>
        <form action={signInWithEmailLink.bind(null, slug, email, token)}>
          <Button>Sign in</Button>
        </form>
      </Card>
    </PublicShell>
  );
}
