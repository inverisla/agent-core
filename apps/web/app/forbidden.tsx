import { PublicShell } from "../components/shells.tsx";
import { Alert, PageHeader } from "../components/ui/index.ts";

// The browser tab's title (WCAG 2.4.2): "No access · <product name>".
export const metadata = { title: "No access" };

export default function Forbidden() {
  return (
    <PublicShell>
      <PageHeader title="No access" />
      <Alert>You are signed in, but you do not have access to this page.</Alert>
    </PublicShell>
  );
}
