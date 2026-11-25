import { PublicShell } from "../components/shells.tsx";
import { Alert, PageHeader } from "../components/ui/index.ts";

// The browser tab's title (WCAG 2.4.2): "Page not found · <product name>".
export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <PublicShell>
      <PageHeader title="Page not found" />
      <Alert>
        There is nothing at this address. Check the link, or go back to the page you came from.
      </Alert>
    </PublicShell>
  );
}
