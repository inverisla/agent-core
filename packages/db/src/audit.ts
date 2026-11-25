// The audit log (task 13): who changed what in a tenant, and who signed in. Each change
// function writes its row in the same transaction as the change, so there is never a
// change without its row, or a row for a change that failed. Rows cannot be changed or
// deleted (migration 0020).
import { and, asc, lte, desc, gt, gte, lt, sql } from "drizzle-orm";
import { auditEvents, signInRefusals } from "./schema.ts";
import type { TenantDatabase, TenantTx } from "./tenant-context.ts";

/** Who did it. A label is their email or name at the time, for reading the log later. */
export type AuditActor =
  | { kind: "user"; userId: string; label: string }
  | { kind: "operator"; oid: string; label: string }
  // A setup command (pnpm tenant:create and the like), run by whoever holds the database
  // credentials.
  | { kind: "setup" }
  // The app itself, on nobody's behalf.
  | { kind: "system" };

export const SETUP_ACTOR: AuditActor = { kind: "setup" };

export type AuditAction =
  | "tenant.created"
  | "user.added"
  | "user.restored"
  | "user.role-changed"
  | "user.removed"
  | "sso.linked"
  | "email-links.changed"
  | "agents.changed"
  | "sign-in"
  | "sign-out";

export type AuditDetail = Record<string, string | number | boolean | null | string[]>;

/** Writes one audit row inside the caller's transaction (in the tenant's context). */
export async function recordAudit(
  tx: TenantTx,
  tenantId: string,
  actor: AuditActor,
  action: AuditAction,
  detail: AuditDetail = {},
): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId,
    actorKind: actor.kind,
    actorId: actor.kind === "user" ? actor.userId : actor.kind === "operator" ? actor.oid : null,
    actorLabel: actor.kind === "user" || actor.kind === "operator" ? actor.label : null,
    action,
    detail,
  });
}

export interface AuditEvent {
  eventId: string;
  /** The order events happened in. */
  seq: number;
  occurredAt: Date;
  actorKind: "user" | "operator" | "setup" | "system";
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  detail: unknown;
}

/**
 * A tenant's audit events, newest first: the latest `limit`, or everything in
 * [from, to) for an export.
 */
export async function listAuditEvents(
  db: TenantDatabase,
  tenantId: string,
  options: { limit?: number; from?: Date; to?: Date } = {},
): Promise<AuditEvent[]> {
  return db.withTenant(tenantId, async (tx) => {
    const query = tx
      .select({
        eventId: auditEvents.eventId,
        seq: auditEvents.seq,
        occurredAt: auditEvents.occurredAt,
        actorKind: auditEvents.actorKind,
        actorId: auditEvents.actorId,
        actorLabel: auditEvents.actorLabel,
        action: auditEvents.action,
        detail: auditEvents.detail,
      })
      .from(auditEvents)
      .where(
        and(
          options.from ? gte(auditEvents.occurredAt, options.from) : undefined,
          options.to ? lt(auditEvents.occurredAt, options.to) : undefined,
        ),
      )
      .orderBy(desc(auditEvents.seq));
    return options.limit ? query.limit(options.limit) : query;
  });
}

/**
 * One page of a tenant's audit events, oldest first, after `afterSeq` (0 for the start):
 * for copying the whole log a page at a time. With `settledMs`, only events up to the
 * highest seq among those stamped at least that long ago by the database's clock, and
 * every event below it. A row's stamp is when its transaction started and its seq when it
 * inserted, so two overlapping transactions can settle out of seq order: filtering on the
 * stamp alone would pass over the earlier one for good (review S4). Any row below a
 * settled one was inserted before it, and no transaction outlasts MAX_TRANSACTION_MS
 * (half the settling time), so it has committed or rolled back by then.
 */
export async function auditEventsAfter(
  db: TenantDatabase,
  tenantId: string,
  afterSeq: number,
  limit: number,
  settledMs = 0,
): Promise<AuditEvent[]> {
  return db.withTenant(tenantId, async (tx) => {
    let upTo: number | null = null;
    if (settledMs > 0) {
      // The newest settled event not yet copied: read backwards along the (tenant, seq)
      // index from the newest, past the few unsettled ones, so it stays quick however
      // long the history grows (review S4).
      const [settled] = await tx
        .select({ seq: auditEvents.seq })
        .from(auditEvents)
        .where(
          and(
            gt(auditEvents.seq, afterSeq),
            sql`${auditEvents.occurredAt} < now() - (${settledMs} * interval '1 millisecond')`,
          ),
        )
        .orderBy(desc(auditEvents.seq))
        .limit(1);
      if (settled === undefined) return [];
      upTo = Number(settled.seq);
    }
    return tx
      .select({
        eventId: auditEvents.eventId,
        seq: auditEvents.seq,
        occurredAt: auditEvents.occurredAt,
        actorKind: auditEvents.actorKind,
        actorId: auditEvents.actorId,
        actorLabel: auditEvents.actorLabel,
        action: auditEvents.action,
        detail: auditEvents.detail,
      })
      .from(auditEvents)
      .where(
        and(gt(auditEvents.seq, afterSeq), upTo === null ? undefined : lte(auditEvents.seq, upTo)),
      )
      .orderBy(asc(auditEvents.seq))
      .limit(limit);
  });
}

/** The seq of one audit event, or null if there is none with that ID. */
export async function auditEventSeq(
  db: TenantDatabase,
  tenantId: string,
  eventId: string,
): Promise<number | null> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(sql`${auditEvents.eventId} = ${eventId}`),
  );
  return row?.seq ?? null;
}

export type SignInMethod = "microsoft" | "google" | "email-link";

/**
 * Counts one refused sign-in to a tenant, by hour, method and reason code, inside the
 * sign-in's own transaction. Reasons are fixed codes from the sign-in code, never what
 * the person typed.
 */
export async function recordRefusedSignIn(
  tx: TenantTx,
  tenantId: string,
  method: SignInMethod,
  reason: string,
): Promise<void> {
  await tx
    .insert(signInRefusals)
    .values({ tenantId, hour: sql`date_trunc('hour', now())`, method, reason, count: 1 })
    .onConflictDoUpdate({
      target: [
        signInRefusals.tenantId,
        signInRefusals.hour,
        signInRefusals.method,
        signInRefusals.reason,
      ],
      set: { count: sql`${signInRefusals.count} + 1` },
    });
}

export interface RefusedSignIns {
  hour: Date;
  method: string;
  reason: string;
  count: number;
}

/** A tenant's refused sign-in counts since `since`, newest hour first. */
export async function listRefusedSignIns(
  db: TenantDatabase,
  tenantId: string,
  since: Date,
): Promise<RefusedSignIns[]> {
  return db.withTenant(tenantId, (tx) =>
    tx
      .select({
        hour: signInRefusals.hour,
        method: signInRefusals.method,
        reason: signInRefusals.reason,
        count: signInRefusals.count,
      })
      .from(signInRefusals)
      .where(gte(signInRefusals.hour, since))
      .orderBy(desc(signInRefusals.hour), signInRefusals.method, signInRefusals.reason),
  );
}

/**
 * Counts a refused sign-in to the tenant at `slug`, in a transaction of its own; nothing
 * if there is no such tenant. A fault here is logged, never raised: the sign-in is
 * refused either way.
 */
export async function countRefusedSignIn(
  db: TenantDatabase,
  slug: string,
  method: SignInMethod,
  reason: string,
): Promise<void> {
  try {
    const tenantId = await db.tenantIdForSlug(slug);
    if (!tenantId) return;
    await db.withTenant(tenantId, (tx) => recordRefusedSignIn(tx, tenantId, method, reason));
  } catch (error) {
    console.error("refused sign-in not counted:", error instanceof Error ? error.name : "unknown");
  }
}
