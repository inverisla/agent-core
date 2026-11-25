import { OperatorShell } from "../../../../../components/shells.tsx";
import {
  Alert,
  Button,
  Card,
  Field,
  FormStack,
  PageHeader,
} from "../../../../../components/ui/index.ts";
import { requireOperatorPage } from "../../../../../lib/auth/guards.ts";
import { createTenantAction } from "../../../../../lib/operator/actions.ts";

// The browser tab's title (WCAG 2.4.2): "New tenant · <product name>".
export const metadata = { title: "New tenant" };

const ERRORS: Record<string, string> = {
  name: "Give the tenant a name (up to 200 characters).",
  slug: "The portal address needs 3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit, and cannot be a reserved word.",
  "slug-taken": "That portal address is already in use.",
  email: "That is not an email address.",
};

export default async function NewTenantPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; name?: string; slug?: string; adminEmail?: string }>;
}) {
  const operator = await requireOperatorPage();
  const { error, name = "", slug = "", adminEmail = "" } = await searchParams;
  return (
    <OperatorShell name={operator.name ?? operator.email ?? "operator"} inside>
      <PageHeader
        title="New tenant"
        description="The first admin gets an email with the portal's sign-in address."
      />
      {error && Object.hasOwn(ERRORS, error) ? <Alert tone="danger">{ERRORS[error]}</Alert> : null}
      <Card>
        <form action={createTenantAction}>
          <FormStack>
            <Field label="Name" name="name" required maxLength={200} defaultValue={name} />
            <Field
              label="Portal address"
              hint="Lowercase letters, digits and hyphens. The portal is at /t/ followed by this, and it cannot be changed later."
              name="slug"
              required
              defaultValue={slug}
              pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
            />
            <Field
              label="First admin's email"
              type="email"
              name="adminEmail"
              required
              autoComplete="off"
              defaultValue={adminEmail}
            />
            <div>
              <Button>Create tenant</Button>
            </div>
          </FormStack>
        </form>
      </Card>
    </OperatorShell>
  );
}
