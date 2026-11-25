// Email sign-in links for tenant users. A link is single use, expires after 15 minutes,
// and only its SHA-256 hash is stored, inside the tenant's own context.
import { createHash, randomBytes } from "node:crypto";
import {
  activeUser,
  normaliseEmail,
  recordAudit,
  countRefusedSignIn,
  schema,
  type TenantDatabase,
} from "@agent-core/db";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { TENANT_SESSION_MS, type TenantIdentity, type TenantRole } from "./identity.ts";
import { logSignInRefused } from "./log.ts";

export const LINK_LIFETIME_MS = 15 * 60 * 1000;

/**
 * Limits on sign-in emails (review S1): requesting one needs no sign-in, so without them a
 * script could flood someone's inbox at the client's cost. Past a limit nothing is sent,
 * and the person sees the same page as always. Counted in email_link_sends (every email,
 * links and work-account notes alike), not from the tokens, which redemption deletes.
 */
export const LINK_LIMITS = {
  /** Emails to one address in an hour (a sign-in with one of its links starts again). */
  perAddressPerHour: 5,
  /** Links to a tenant's users in an hour. */
  perTenantPerHour: 200,
};
/** Sends are counted for an hour and kept a day. */
const KEEP_SENDS_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export { normaliseEmail };

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** What to email: a sign-in link, or (when the tenant has turned links off) a note
 *  to use the work account instead; or nothing, past a sending limit. */
export type EmailLinkOutcome =
  | { kind: "link"; to: string; url: string }
  | { kind: "use-sso"; to: string }
  | { kind: "too-many" };

type Tx = Parameters<Parameters<TenantDatabase["withTenant"]>[1]>[0];

async function emailLinksAllowed(tx: Tx) {
  const [sso] = await tx.select().from(schema.tenantSso);
  return sso?.allowEmailLinks ?? true;
}

/**
 * Counts one email to `email` against the sending limits, inside the tenant's
 * transaction; false (and nothing counted) past a limit, when nothing should be sent.
 * Every email to an address that needs no sign-in to trigger goes through this: sign-in
 * links, work-account notes and welcome emails (review S14).
 */
export async function claimEmailSend(
  tx: Tx,
  tenantId: string,
  email: string,
  now = Date.now(),
): Promise<boolean> {
  // One request at a time per address, so parallel requests cannot all pass the limits
  // before any of them is counted. Ends with the transaction. The tenant total is not
  // locked, so requests for many addresses at once can pass it by a few.
  await tx.execute(
    sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`email-link:${email}`}))`,
  );
  const sends = schema.emailLinkSends;
  // Day-old sends go, so the log cannot grow without bound.
  await tx.delete(sends).where(lte(sends.sentAt, new Date(now - KEEP_SENDS_MS)));
  const [recent] = await tx
    .select({
      tenant: sql<number>`count(*)::int`,
      address: sql<number>`count(*) filter (where ${sends.identifier} = ${email})::int`,
    })
    .from(sends)
    .where(and(gt(sends.sentAt, new Date(now - HOUR_MS)), lte(sends.sentAt, new Date(now))));
  const address = recent?.address ?? 0;
  if (
    address >= LINK_LIMITS.perAddressPerHour ||
    // The tenant cap never refuses an address's first email in the hour, so nobody can
    // lock a whole tenant out of email sign-in by flooding a few addresses.
    ((recent?.tenant ?? 0) >= LINK_LIMITS.perTenantPerHour && address > 0)
  ) {
    return false;
  }
  await tx.insert(sends).values({ tenantId, identifier: email, sentAt: new Date(now) });
  return true;
}

/**
 * Creates a sign-in link if the email belongs to a user of the tenant, or says to use
 * the work account if the tenant has turned links off. Returns null when the address is
 * not a user; callers must respond the same way in every case.
 */
export async function createEmailLink(
  db: TenantDatabase,
  input: { slug: string; email: string; baseUrl: string; now?: number },
): Promise<EmailLinkOutcome | null> {
  const email = normaliseEmail(input.email);
  if (!email) return null;
  const tenantId = await db.tenantIdForSlug(input.slug);
  if (!tenantId) return null;
  const now = input.now ?? Date.now();
  const token = randomBytes(32).toString("base64url");
  const created = await db.withTenant(tenantId, async (tx) => {
    const users = schema.users;
    const [user] = await tx
      .select({ id: users.userId })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, activeUser));
    if (!user) return "none" as const;
    if (!(await claimEmailSend(tx, tenantId, email, now))) return "too-many" as const;
    if (!(await emailLinksAllowed(tx))) return "use-sso" as const;
    const tokens = schema.verificationTokens;
    await tx.delete(tokens).where(lte(tokens.expires, new Date(now)));
    await tx.insert(tokens).values({
      tenantId,
      identifier: email,
      tokenHash: hashToken(token),
      expires: new Date(now + LINK_LIFETIME_MS),
      createdAt: new Date(now),
    });
    return "link" as const;
  });
  if (created === "none") return null;
  if (created === "too-many") {
    // Counted for the tenant's Activity page, and logged for the sign-in-refusals alert
    // (infra/azure/modules/monitoring.bicep), never with the address.
    logSignInRefused("too-many-links", { kind: "tenant", slug: input.slug }, "email-link");
    await countRefusedSignIn(db, input.slug, "email-link", "too-many-links");
    return { kind: "too-many" };
  }
  if (created === "use-sso") return { kind: "use-sso", to: email };
  const url = new URL(`/t/${input.slug}/sign-in/verify`, input.baseUrl);
  url.searchParams.set("email", email);
  url.searchParams.set("token", token);
  return { kind: "link", to: email, url: url.toString() };
}

export type EmailLinkRefusal =
  "link-not-valid" | "email-links-off" | "unknown-user" | "unknown-tenant";
export type EmailLinkResult =
  { ok: true; identity: TenantIdentity } | { ok: false; reason: EmailLinkRefusal };

type LinkInput = { slug: string; email: string; token: string; now?: number };

/** Uses up a sign-in link. Returns the identity, or null if the link is not valid. */
export async function consumeEmailLink(
  db: TenantDatabase,
  input: LinkInput,
): Promise<TenantIdentity | null> {
  const result = await redeemEmailLink(db, input);
  return result.ok ? result.identity : null;
}

/** Uses up a sign-in link, saying why it was refused; a refusal is counted (task 13). */
export async function redeemEmailLink(
  db: TenantDatabase,
  input: LinkInput,
): Promise<EmailLinkResult> {
  const result = await decideEmailLink(db, input);
  if (!result.ok) await countRefusedSignIn(db, input.slug, "email-link", result.reason);
  return result;
}

async function decideEmailLink(db: TenantDatabase, input: LinkInput): Promise<EmailLinkResult> {
  const email = normaliseEmail(input.email);
  if (!email || input.token.length < 32) return { ok: false, reason: "link-not-valid" };
  const tenantId = await db.tenantIdForSlug(input.slug);
  if (!tenantId) return { ok: false, reason: "unknown-tenant" };
  const now = new Date(input.now ?? Date.now());
  return db.withTenant(tenantId, async (tx): Promise<EmailLinkResult> => {
    const tokens = schema.verificationTokens;
    const [used] = await tx
      .delete(tokens)
      .where(
        and(
          eq(tokens.identifier, email),
          eq(tokens.tokenHash, hashToken(input.token)),
          gt(tokens.expires, now),
        ),
      )
      .returning();
    // Links sent before the tenant turned them off stop working too.
    if (used && !(await emailLinksAllowed(tx))) return { ok: false, reason: "email-links-off" };
    if (!used) {
      await tx.delete(tokens).where(and(eq(tokens.identifier, email), lte(tokens.expires, now)));
      return { ok: false, reason: "link-not-valid" };
    }
    // One link used: the user's other outstanding links stop working too. And, since
    // only the inbox's owner could use it, their sends stop counting against them (a
    // refused link, above, does not do this).
    await tx.delete(tokens).where(eq(tokens.identifier, email));
    await tx.delete(schema.emailLinkSends).where(eq(schema.emailLinkSends.identifier, email));
    const users = schema.users;
    const [user] = await tx
      .select()
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, activeUser));
    if (!user) return { ok: false, reason: "unknown-user" };
    await recordAudit(
      tx,
      tenantId,
      { kind: "user", userId: user.userId, label: user.email },
      "sign-in",
      { method: "email-link" },
    );
    return {
      ok: true,
      identity: {
        kind: "tenant",
        tenantId,
        slug: input.slug,
        userId: user.userId,
        role: user.role as TenantRole,
        expiresAt: now.getTime() + TENANT_SESSION_MS,
      },
    };
  });
}
