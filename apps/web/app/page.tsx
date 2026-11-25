import { PublicShell } from "../components/shells.tsx";
import { Card, PageHeader } from "../components/ui/index.ts";
import { theme } from "../theme.ts";

export default function HomePage() {
  return (
    <PublicShell>
      <PageHeader
        title={theme.productName}
        description="Document processing for your organisation."
      />
      <Card>
        <p>
          Users sign in through the link to their own tenant&rsquo;s portal. Staff who build and run
          the agents use the <a href="/operator">operator console</a>.
        </p>
      </Card>
    </PublicShell>
  );
}
