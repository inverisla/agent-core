// Adds a user to an existing tenant:
//   pnpm tenant:add-user -- --slug demo-ltd --email someone@example.com [--role admin|user] [--name "Their Name"]
import { parseCliArgs, runCli, UsageError } from "./cli.ts";
import { SETUP_ACTOR } from "./audit.ts";
import { addTenantUser } from "./tenant-users.ts";

const usage =
  'Usage: pnpm tenant:add-user -- --slug <slug> --email <address> [--role admin] [--name "Their Name"]   (--role is "user" unless given)';

await runCli(usage, async (db) => {
  const values = parseCliArgs({
    slug: { type: "string" },
    email: { type: "string" },
    role: { type: "string", default: "user" },
    name: { type: "string" },
  });
  if (!values.slug || !values.email || (values.role !== "admin" && values.role !== "user")) {
    throw new UsageError();
  }
  const tenantId = await db().tenantIdForSlug(values.slug);
  if (!tenantId) throw new Error(`No tenant with slug "${values.slug}".`);
  await addTenantUser(
    db(),
    tenantId,
    {
      email: values.email,
      ...(values.name ? { displayName: values.name } : {}),
      role: values.role === "admin" ? "tenant_admin" : "tenant_user",
    },
    SETUP_ACTOR,
  );
  console.log(`added ${values.email.trim().toLowerCase()} to /t/${values.slug} as ${values.role}`);
});
