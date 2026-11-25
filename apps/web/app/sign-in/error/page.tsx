import { PublicShell } from "../../../components/shells.tsx";
import { Alert, PageHeader } from "../../../components/ui/index.ts";

// The browser tab's title (WCAG 2.4.2): "Sign-in failed · <product name>".
export const metadata = { title: "Sign-in failed" };

export default function SignInErrorPage() {
  return (
    <PublicShell>
      <PageHeader title="Sign-in failed" />
      <Alert tone="danger">Sign-in could not be completed. Go back and try again.</Alert>
    </PublicShell>
  );
}
