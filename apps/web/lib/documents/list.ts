import { schema, type TenantDatabase } from "@agent-core/db";
import { desc, gte, sql } from "drizzle-orm";

export interface DocumentSummary {
  documentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

/** Documents shown at a time (review Q8). */
export const DOCUMENTS_PER_PAGE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentPage {
  documents: DocumentSummary[];
  /** Where the next, older page starts (a document ID), or null if this is the last. */
  older: string | null;
}

/**
 * A page of the tenant's documents, newest first: the newest ones, or those older than
 * the document `before` (the `older` of the page before). Every document can be reached,
 * however many there are. A `before` that is not one of the tenant's documents gives an
 * empty page.
 */
export async function documentPage(
  db: TenantDatabase,
  tenantId: string,
  before: string | null = null,
  limit = DOCUMENTS_PER_PAGE,
): Promise<DocumentPage> {
  const d = schema.documents;
  const rows = await db.withTenant(tenantId, (tx) =>
    tx
      .select({
        documentId: d.documentId,
        filename: d.filename,
        contentType: d.contentType,
        sizeBytes: d.sizeBytes,
        createdAt: d.createdAt,
      })
      .from(d)
      .where(
        before === null
          ? undefined
          : UUID.test(before)
            ? // Keyset: after the cursor in (created_at, document_id) order, so documents
              // uploaded meanwhile neither repeat nor go missing.
              sql`(${d.createdAt}, ${d.documentId}) < (select c.created_at, c.document_id from ${d} c where c.document_id = ${before})`
            : sql`false`,
      )
      .orderBy(desc(d.createdAt), desc(d.documentId))
      .limit(limit + 1),
  );
  const documents = rows.slice(0, limit);
  return {
    documents,
    older: rows.length > limit ? (documents.at(-1)?.documentId ?? null) : null,
  };
}

/** The newest page of the tenant's documents. */
export async function listDocuments(
  db: TenantDatabase,
  tenantId: string,
): Promise<DocumentSummary[]> {
  return (await documentPage(db, tenantId)).documents;
}

/** Default for MAX_UPLOADS_PER_TENANT_PER_DAY. */
export const DEFAULT_UPLOADS_PER_DAY = 500;

/** A tenant's uploads in a rolling 24 hours: each costs model calls (review S5). */
export function maxUploadsPerDay(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env["MAX_UPLOADS_PER_TENANT_PER_DAY"] ?? DEFAULT_UPLOADS_PER_DAY);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_UPLOADS_PER_DAY;
}

/** How many documents the tenant has uploaded since `since`. */
export async function uploadsSince(
  db: TenantDatabase,
  tenantId: string,
  since: Date,
): Promise<number> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.documents)
      .where(gte(schema.documents.createdAt, since)),
  );
  return row?.n ?? 0;
}
