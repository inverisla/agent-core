// Taking in a document: checks first, then the file into the tenant's container, then the
// record in the tenant's signed context. If the record fails, the file is removed again.
import { createHash, randomUUID } from "node:crypto";
import { schema, type TenantDatabase } from "@agent-core/db";
import type { BlobServiceClient } from "@azure/storage-blob";
import { cleanFilename, detectType, type AcceptedType } from "./file-type.ts";
import { documentBlobName, tenantContainer } from "@agent-core/core/storage";

export const DEFAULT_MAX_UPLOAD_MB = 25;

export function maxUploadBytes(): number {
  const mb = Number(process.env["MAX_UPLOAD_MB"] ?? DEFAULT_MAX_UPLOAD_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
}

export type IntakeRefusal = "empty" | "too-large" | "unsupported-type" | "protected-or-legacy";

export interface StoredDocument {
  documentId: string;
  filename: string;
  contentType: AcceptedType;
  sizeBytes: number;
  blobPath: string;
  sha256: string;
}

export type IntakeResult =
  { ok: true; document: StoredDocument } | { ok: false; reason: IntakeRefusal };

export async function intakeDocument(input: {
  db: TenantDatabase;
  blobs: BlobServiceClient;
  tenantId: string;
  userId: string;
  filename: string;
  bytes: Buffer;
  maxBytes: number;
}): Promise<IntakeResult> {
  const { bytes } = input;
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > input.maxBytes) return { ok: false, reason: "too-large" };
  const detected = detectType(bytes);
  if (detected === "protected-or-legacy") return { ok: false, reason: detected };
  if (!detected) return { ok: false, reason: "unsupported-type" };
  const contentType: AcceptedType = detected;

  const documentId = randomUUID();
  const filename = cleanFilename(input.filename, contentType);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const container = await tenantContainer(input.blobs, input.tenantId);
  const blobName = documentBlobName(documentId);
  const blob = container.getBlockBlobClient(blobName);

  await blob.uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: contentType, blobContentDisposition: "attachment" },
    metadata: { tenantid: input.tenantId, documentid: documentId },
  });
  const document: StoredDocument = {
    documentId,
    filename,
    contentType,
    sizeBytes: bytes.length,
    blobPath: `${container.containerName}/${blobName}`,
    sha256,
  };
  try {
    await input.db.withTenant(input.tenantId, (tx) =>
      tx
        .insert(schema.documents)
        .values({ ...document, tenantId: input.tenantId, uploadedBy: input.userId }),
    );
  } catch (error) {
    // Remove the file again so it has no record. If that fails too, say so and keep
    // the original error. (A crash between the two steps can still leave a file
    // without a record; a clean-up job can sweep those later.)
    await blob.deleteIfExists().catch((cleanupError: unknown) => {
      console.error(
        `could not remove ${container.containerName}/${blobName} after a failed record:`,
        cleanupError instanceof Error ? cleanupError.name : "unknown error",
      );
    });
    throw error;
  }
  return { ok: true, document };
}
