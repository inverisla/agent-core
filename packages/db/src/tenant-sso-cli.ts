// Links a tenant's single sign-on, or switches its email links on or off. Until the
// operator console manages tenants, this is also how an operator turns email links back
// on for a tenant whose admins are locked out.
//   pnpm tenant:sso -- --slug demo-ltd --google lawfirm.example
//   pnpm tenant:sso -- --slug demo-ltd --microsoft <entra-tenant-id>
//   pnpm tenant:sso -- --slug demo-ltd --email-links on|off
import { parseCliArgs, runCli, UsageError } from "./cli.ts";
import { SETUP_ACTOR } from "./audit.ts";
import { getTenantSso, linkTenantSso, setAllowEmailLinks } from "./tenant-sso.ts";

const usage =
  "Usage: pnpm tenant:sso -- --slug <slug> [--google <domain> | --microsoft <entra-tenant-id>] [--email-links on|off]";

await runCli(usage, async (db) => {
  const values = parseCliArgs({
    slug: { type: "string" },
    google: { type: "string" },
    microsoft: { type: "string" },
    "email-links": { type: "string" },
  });
  const emailLinks = values["email-links"];
  if (
    !values.slug ||
    (values.google && values.microsoft) ||
    (emailLinks !== undefined && emailLinks !== "on" && emailLinks !== "off")
  ) {
    throw new UsageError();
  }
  const tenantId = await db().tenantIdForSlug(values.slug);
  if (!tenantId) throw new Error(`No tenant with slug "${values.slug}".`);
  if (values.google)
    await linkTenantSso(
      db(),
      tenantId,
      { provider: "google", googleDomain: values.google },
      SETUP_ACTOR,
    );
  if (values.microsoft)
    await linkTenantSso(
      db(),
      tenantId,
      { provider: "microsoft", entraTenantId: values.microsoft },
      SETUP_ACTOR,
    );
  if (emailLinks && !(await setAllowEmailLinks(db(), tenantId, emailLinks === "on", SETUP_ACTOR))) {
    throw new Error("Email links can only be turned off once SSO is linked.");
  }
  const sso = await getTenantSso(db(), tenantId);
  const linked = sso.link
    ? sso.link.provider === "google"
      ? `Google Workspace (${sso.link.googleDomain})`
      : `Microsoft (${sso.link.entraTenantId})`
    : "none";
  console.log(
    `/t/${values.slug}: SSO ${linked}; email links ${sso.allowEmailLinks ? "on" : "off"}`,
  );
});
