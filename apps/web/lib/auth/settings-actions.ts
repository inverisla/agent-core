"use server";

import { setAllowEmailLinks } from "@agent-core/db";
import { redirect } from "next/navigation";
import { db } from "../server/db.ts";
import { tenantActor } from "./actors.ts";
import { canTurnOffEmailLinks } from "./email-link-switch.ts";
import { checkTenant } from "./guards.ts";

/**
 * Tenant admins only. Turning links off is refused unless the tenant's SSO works and
 * this admin has already signed in with it, so nobody is locked out.
 */
export async function setEmailLinks(slug: string, allow: unknown) {
  if (typeof allow !== "boolean") redirect(`/t/${encodeURIComponent(slug)}/sign-in`);
  const access = await checkTenant(slug, { admin: true });
  if (!access.ok) redirect(`/t/${encodeURIComponent(slug)}/sign-in`);
  if (!allow) {
    const check = await canTurnOffEmailLinks(access.value);
    if (!check.ok) redirect(`/t/${slug}/admin/sign-in?error=${check.reason}`);
  }
  const done = await setAllowEmailLinks(
    db(),
    access.value.tenantId,
    allow,
    tenantActor(access.value),
  );
  redirect(`/t/${slug}/admin/sign-in?${done ? "saved=1" : "error=sso-not-available"}`);
}
