// The audit log's write-once copy (task 14). Every few minutes, each tenant's new
// audit_events rows are appended, as JSON lines, to an append blob in a container with a
// time-based retention policy, where nobody (the database owner included) can change or
// delete them. The database cannot alter what has been copied; a row deleted from it
// before it is copied (a few minutes at most) is lost from the copy too.
//
// - Where the copy has got to is read from the copy itself: the last line of the tenant's
//   newest blob. Nothing in the database can move it.
// - Events are copied up to the highest seq among those older than SETTLE_MS, and every
//   one below it. A row's seq is taken when it is inserted, not when it commits, so a
//   recent row with a lower seq may still appear; but any row below a settled one was
//   inserted earlier, and no app transaction lasts longer than MAX_TRANSACTION_MS, so it
//   has committed or rolled back (auditEventsAfter in @agent-core/db).
// - Events are filed by the day they are copied, so seqs only rise from blob to blob.
// - Each append is conditional on the exact end of the copy seen at the start, so two
//   copies at once cannot both write the same events: the second simply stops.
// - If the copy's last event is not in the database with the same seq, the database was
//   restored to an earlier point (or rows were removed): the copy stops for that tenant
//   and alerts. Setting AUDIT_COPY_EPOCH starts a fresh copy (docs/operations.md).
import {
  auditEventSeq,
  auditEventsAfter,
  MAX_TRANSACTION_MS,
  type AuditEvent,
  type TenantDatabase,
} from "@agent-core/db";
import { auditCopyBlobName, auditCopyPrefix } from "@agent-core/core/storage";
import { logEvent } from "@agent-core/core/telemetry";
import { RestError, type ContainerClient } from "@azure/storage-blob";

const PAGE = 500;
/** Kept well under an append block's limit. */
const MAX_APPEND_BYTES = 2 * 1024 * 1024;
/** Copy only events this old: twice the longest an app transaction can last. */
export const SETTLE_MS = 2 * MAX_TRANSACTION_MS;

export interface CopyOptions {
  pageSize?: number;
  now?: () => Date;
  settleMs?: number;
  /** AUDIT_COPY_EPOCH: 1 unless a restored database made a fresh copy necessary. */
  epoch?: number;
  /** Called after each tenant, so a long run can tell Temporal it is alive. */
  onProgress?: () => void;
}

export interface CopyResult {
  tenants: number;
  copied: number;
  failed: number;
}

/** The copy and the database disagree about an event already copied. */
export class CopyDiverged extends Error {
  override name = "CopyDiverged";
}

/** One line of the copy: the event as stored, with its tenant. */
function line(tenantId: string, e: AuditEvent): string {
  return (
    JSON.stringify({
      tenantId,
      seq: e.seq,
      eventId: e.eventId,
      occurredAt: e.occurredAt.toISOString(),
      actorKind: e.actorKind,
      actorId: e.actorId,
      actorLabel: e.actorLabel,
      action: e.action,
      detail: e.detail,
    }) + "\n"
  );
}

/** Where a tenant's copy ends: its last event, and the blob and length it ends at. */
export interface CopyEnd {
  seq: number;
  eventId: string | null;
  /** The newest blob (perhaps empty, after a crash), or null if there is none. */
  name: string | null;
  length: number;
}

export async function copyEnd(
  container: ContainerClient,
  tenantId: string,
  epoch = 1,
): Promise<CopyEnd> {
  const names: string[] = [];
  for await (const blob of container.listBlobsFlat({ prefix: auditCopyPrefix(tenantId, epoch) })) {
    names.push(blob.name);
  }
  names.sort().reverse();
  const newest = names[0] ?? null;
  let length = 0;
  // Newest first; a blob created but never written to (a crash) has no lines.
  for (const name of names) {
    const buffer = await container.getAppendBlobClient(name).downloadToBuffer();
    if (name === newest) length = buffer.length;
    const last = buffer.toString("utf8").trimEnd().split("\n").at(-1);
    if (last) {
      const e = JSON.parse(last) as { seq: number; eventId: string };
      return { seq: Number(e.seq), eventId: e.eventId, name: newest, length };
    }
  }
  return { seq: 0, eventId: null, name: newest, length };
}

/** The highest sequence number already copied for a tenant (0 if none). */
export async function lastCopiedSeq(
  container: ContainerClient,
  tenantId: string,
  epoch = 1,
): Promise<number> {
  return (await copyEnd(container, tenantId, epoch)).seq;
}

/** Another copy wrote first (the append was conditional on the end we saw). */
function lostRace(error: unknown): boolean {
  return error instanceof RestError && error.statusCode === 412;
}

/**
 * Appends `text` to blob `name` exactly where this copy expects its end to be: at
 * `end.length` of the blob it last saw, or at the start of a new, still empty blob.
 */
async function appendAt(
  container: ContainerClient,
  name: string,
  end: { name: string | null; length: number },
  text: string,
): Promise<{ name: string; length: number }> {
  const blob = container.getAppendBlobClient(name);
  const at = name === end.name ? end.length : 0;
  if (name !== end.name) await blob.createIfNotExists();
  const body = Buffer.from(text, "utf8");
  await blob.appendBlock(body, body.length, { conditions: { appendPosition: at } });
  return { name, length: at + body.length };
}

/** Copies one tenant's settled new events. Returns how many. */
export async function copyTenantAuditLog(
  db: TenantDatabase,
  container: ContainerClient,
  tenantId: string,
  options: CopyOptions = {},
): Promise<number> {
  const pageSize = options.pageSize ?? PAGE;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const epoch = options.epoch ?? 1;
  const start = await copyEnd(container, tenantId, epoch);
  if (start.eventId && (await auditEventSeq(db, tenantId, start.eventId)) !== start.seq) {
    throw new CopyDiverged();
  }
  let after = start.seq;
  let end: { name: string | null; length: number } = start;
  let copied = 0;
  try {
    for (;;) {
      const page = await auditEventsAfter(db, tenantId, after, pageSize, settleMs);
      if (page.length === 0) return copied;
      // Today's blob, or a later one already started (a clock behind another copy's).
      const today = auditCopyBlobName(
        tenantId,
        (options.now?.() ?? new Date()).toISOString().slice(0, 10),
        epoch,
      );
      const name = end.name && end.name > today ? end.name : today;
      let batch = "";
      let inBatch = 0;
      for (const e of page) {
        const next = line(tenantId, e);
        if (batch && Buffer.byteLength(batch + next) > MAX_APPEND_BYTES) {
          end = await appendAt(container, name, end, batch);
          copied += inBatch;
          batch = "";
          inBatch = 0;
        }
        batch += next;
        inBatch++;
      }
      end = await appendAt(container, name, end, batch);
      copied += inBatch;
      after = page[page.length - 1]?.seq ?? after;
      if (page.length < pageSize) return copied;
    }
  } catch (error) {
    // Another copy got there first: nothing is lost, and the next run carries on from
    // wherever the copy really ends.
    if (lostRace(error)) return copied;
    throw error;
  }
}

/** Copies every tenant's new events. One tenant's failure does not stop the others. */
export async function copyAuditLog(
  db: TenantDatabase,
  container: ContainerClient,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const result: CopyResult = { tenants: 0, copied: 0, failed: 0 };
  for (const { tenantId } of await db.listTenants()) {
    result.tenants++;
    try {
      result.copied += await copyTenantAuditLog(db, container, tenantId, options);
    } catch (error) {
      result.failed++;
      // The "audit copy failed" alert watches for this.
      logEvent(
        "audit.copy-failed",
        { tenantId, error: error instanceof Error ? error.name : "unknown" },
        "error",
      );
    }
    options.onProgress?.();
  }
  if (result.copied > 0 || result.failed > 0) {
    logEvent("audit.copied", {
      tenants: result.tenants,
      events: result.copied,
      failed: result.failed,
    });
  }
  return result;
}
