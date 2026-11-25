// Creates a tenant with its first admin, for local development and first setup:
//   pnpm tenant:create --name "Demo Ltd" --admin-email you@example.com [--slug demo-ltd]
//                      [--entra-tenant-id <guid>]
import { parseCliArgs, runCli, UsageError } from "./cli.ts";
import { SETUP_ACTOR } from "./audit.ts";
import { slugFromName } from "./tenant-slug.ts";
import { linkTenantSso } from "./tenant-sso.ts";
import { createTenantWithAdmin } from "./tenant-users.ts";

const usage =
  'Usage: pnpm tenant:create -- --name "Demo Ltd" --admin-email you@example.com [--slug demo-ltd] [--entra-tenant-id <guid>]';

await runCli(usage, async (db) => {
  const values = parseCliArgs({
    name: { type: "string" },
    slug: { type: "string" },
    "admin-email": { type: "string" },
    "entra-tenant-id": { type: "string" },
  });
  const name = values.name;
  const adminEmail = values["admin-email"]?.trim().toLowerCase();
  if (!name || !adminEmail) throw new UsageError();
  const slug = values.slug ?? slugFromName(name);
  const tenantId = await createTenantWithAdmin(db(), { name, slug, adminEmail }, SETUP_ACTOR);
  const entraTenantId = values["entra-tenant-id"];
  if (entraTenantId)
    await linkTenantSso(db(), tenantId, { provider: "microsoft", entraTenantId }, SETUP_ACTOR);
  console.log(`tenant created: /t/${slug} (admin ${adminEmail})`);
});
