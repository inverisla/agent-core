// A tenant's users: adding, listing, changing roles and removing (task 12b), for the
// operator console, the tenant admin pages and the setup commands.
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { tenants, users, verificationTokens } from "./schema.ts";
import { recordAudit, type AuditActor } from "./audit.ts";
import { slugProblem } from "./tenant-slug.ts";
import type { TenantDatabase } from "./tenant-context.ts";

export type TenantUserRole = "tenant_admin" | "tenant_user";

// No whitespace, @ or control characters in either part; a dot in the domain.
const EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;
const MAX_NAME = 200;

/** A lowercase, trimmed email address, or null if it is not one. */
export function normaliseEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  return EMAIL.test(e) && e.length <= 320 ? e : null;
}

/** Users who have not been removed: every sign-in and access check uses this. */
export const activeUser = isNull(users.removedAt);

/**
 * Adds a user to a tenant, or restores one who was removed (with the role given).
 * Emails are stored lowercase and are unique per tenant, regardless of case. Returns
 * the user's ID.
 */
export async function addTenantUser(
  db: TenantDatabase,
  tenantId: string,
  input: { email: string; displayName?: string; role: TenantUserRole },
  actor: AuditActor,
): Promise<string> {
  const email = normaliseEmail(input.email);
  if (!email) throw new Error("That is not an email address.");
  const displayName = input.displayName?.trim() || email;
  if (displayName.length > MAX_NAME)
    throw new Error(`Names can be at most ${MAX_NAME} characters.`);
  try {
    return await db.withTenant(tenantId, async (tx) => {
      // A removed user with this address comes back, keeping their history. Their old
      // sessions, sign-in links and name stay behind: the address may be someone else's now.
      const [restored] = await tx
        .update(users)
        .set({ removedAt: null, role: input.role, displayName, sessionsValidAfter: sql`now()` })
        .where(and(sql`lower(${users.email}) = ${email}`, sql`${users.removedAt} is not null`))
        .returning({ id: users.userId });
      if (restored) {
        await tx.delete(verificationTokens).where(eq(verificationTokens.identifier, email));
        await recordAudit(tx, tenantId, actor, "user.restored", {
          userId: restored.id,
          email,
          role: input.role,
        });
        return restored.id;
      }
      // No separate "already exists?" query: the unique index on (tenant_id,
      // lower(email)) decides, so concurrent adds of the same address cannot both succeed.
      const [row] = await tx
        .insert(users)
        .values({ tenantId, email, displayName, role: input.role })
        .returning({ id: users.userId });
      if (!row) throw new Error("The user was not created.");
      await recordAudit(tx, tenantId, actor, "user.added", {
        userId: row.id,
        email,
        role: input.role,
      });
      return row.id;
    });
  } catch (error) {
    // Never pass the raw database error on: it contains the query's values.
    const cause =
      error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
    if (cause?.code === "23505") {
      throw new Error(`${email} is already a user of this tenant.`);
    }
    throw error;
  }
}

export interface TenantUser {
  userId: string;
  email: string;
  displayName: string;
  role: TenantUserRole;
  createdAt: Date;
  removedAt: Date | null;
}

/** The tenant's users, current ones first, each group by email. */
export async function listTenantUsers(db: TenantDatabase, tenantId: string): Promise<TenantUser[]> {
  return db.withTenant(tenantId, (tx) =>
    tx
      .select({
        userId: users.userId,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
        removedAt: users.removedAt,
      })
      .from(users)
      .orderBy(sql`${users.removedAt} is not null`, asc(users.email)),
  );
}

export type UserChangeRefusal = "not-found" | "last-admin" | "self";

/**
 * The current admins, locked for the rest of the transaction, so two changes at once
 * cannot each remove a different "other" admin and leave none.
 */
async function lockedAdmins(tx: Parameters<Parameters<TenantDatabase["withTenant"]>[1]>[0]) {
  return tx
    .select({ userId: users.userId })
    .from(users)
    .where(and(eq(users.role, "tenant_admin"), activeUser))
    .for("update");
}

/** Changes a user's role; refused if it would leave the tenant with no admin. */
export async function setTenantUserRole(
  db: TenantDatabase,
  tenantId: string,
  input: { userId: string; role: TenantUserRole },
  actor: AuditActor,
): Promise<{ ok: true } | { ok: false; reason: UserChangeRefusal }> {
  return db.withTenant(tenantId, async (tx) => {
    const admins = await lockedAdmins(tx);
    const [user] = await tx
      .select({ role: users.role, email: users.email })
      .from(users)
      .where(and(eq(users.userId, input.userId), activeUser));
    if (!user) return { ok: false, reason: "not-found" };
    if (user.role === input.role) return { ok: true };
    const lastAdmin =
      user.role === "tenant_admin" && input.role !== "tenant_admin" && admins.length <= 1;
    if (lastAdmin) return { ok: false, reason: "last-admin" };
    await tx.update(users).set({ role: input.role }).where(eq(users.userId, input.userId));
    await recordAudit(tx, tenantId, actor, "user.role-changed", {
      userId: input.userId,
      email: user.email,
      from: user.role,
      to: input.role,
    });
    return { ok: true };
  });
}

/**
 * Removes a user: they can no longer sign in, and their name stays on their history.
 * Refused for the acting admin themselves, and for the tenant's last admin.
 */
export async function removeTenantUser(
  db: TenantDatabase,
  tenantId: string,
  input: { userId: string },
  actor: AuditActor,
): Promise<{ ok: true } | { ok: false; reason: UserChangeRefusal }> {
  if (actor.kind === "user" && actor.userId === input.userId) return { ok: false, reason: "self" };
  return db.withTenant(tenantId, async (tx) => {
    const admins = await lockedAdmins(tx);
    const [user] = await tx
      .select({ role: users.role, email: users.email })
      .from(users)
      .where(and(eq(users.userId, input.userId), activeUser));
    if (!user) return { ok: false, reason: "not-found" };
    if (user.role === "tenant_admin" && admins.length <= 1)
      return { ok: false, reason: "last-admin" };
    // Signed out everywhere, unlinked from Microsoft and Google, and any sign-in link
    // they were sent stops working.
    await tx
      .update(users)
      .set({
        removedAt: sql`now()`,
        sessionsValidAfter: sql`now()`,
        entraObjectId: null,
        googleSubject: null,
      })
      .where(eq(users.userId, input.userId));
    await tx
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, normaliseEmail(user.email) ?? user.email));
    await recordAudit(tx, tenantId, actor, "user.removed", {
      userId: input.userId,
      email: user.email,
      role: user.role,
    });
    return { ok: true };
  });
}

/**
 * Signs a user out everywhere (review S15): every session of theirs begun before now
 * stops working, so a copied session cookie is no use after sign-out. Their own action,
 * recorded like a sign-in.
 */
export async function endUserSessions(
  db: TenantDatabase,
  tenantId: string,
  actor: AuditActor & { kind: "user" },
): Promise<void> {
  await db.withTenant(tenantId, async (tx) => {
    const [user] = await tx
      .update(users)
      // The app's clock, as the guard compares it with a session start from the app's
      // clock: a database clock running ahead must not refuse the next sign-in.
      .set({ sessionsValidAfter: new Date() })
      .where(and(eq(users.userId, actor.userId), activeUser))
      .returning({ userId: users.userId });
    if (user) await recordAudit(tx, tenantId, actor, "sign-out", {});
  });
}

/**
 * Creates a tenant with its first admin, together or not at all.
 */
export async function createTenantWithAdmin(
  db: TenantDatabase,
  input: { name: string; slug: string; adminEmail: string },
  actor: AuditActor,
): Promise<string> {
  const email = normaliseEmail(input.adminEmail);
  if (!email) throw new Error("The admin email is not an email address.");
  const problem = slugProblem(input.slug);
  if (problem !== null) throw new Error(`Invalid tenant slug: ${problem}`);
  // One transaction in the new tenant's own context: a tenant never exists without its
  // admin, and a failed attempt leaves nothing behind.
  const tenantId = randomUUID();
  await db.withTenant(tenantId, async (tx) => {
    await tx.insert(tenants).values({ tenantId, name: input.name, slug: input.slug });
    const [admin] = await tx
      .insert(users)
      .values({ tenantId, email, displayName: email, role: "tenant_admin" })
      .returning({ id: users.userId });
    await recordAudit(tx, tenantId, actor, "tenant.created", {
      name: input.name,
      slug: input.slug,
    });
    await recordAudit(tx, tenantId, actor, "user.added", {
      userId: admin?.id ?? null,
      email,
      role: "tenant_admin",
    });
  });
  return tenantId;
}
