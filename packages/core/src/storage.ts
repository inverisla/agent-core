// Azure Blob Storage for tenant files: one private container per tenant, named from the
// tenant ID, with uploads at documents/{document_id} and reports at
// reports/{job_id}.docx. Paths are only ever built here, from server-side IDs; nothing a
// user sends becomes part of a path. The web app and the worker both use this module.
//
// Postgres row-level security does not reach Blob Storage, and one credential covers
// every tenant, so this naming is what keeps tenants' files apart.
import { ManagedIdentityCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type ContainerClient,
  type StoragePipelineOptions,
} from "@azure/storage-blob";

/**
 * Every Blob Storage call (task 14): each try gives up after 60 s (the SDK's default has
 * no limit), and a failed one is tried up to 4 times with backoff.
 */
export const BLOB_OPTIONS: StoragePipelineOptions = {
  retryOptions: {
    maxTries: 4,
    tryTimeoutInMs: 60_000,
    retryDelayInMs: 1_000,
    maxRetryDelayInMs: 15_000,
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantContainerName(tenantId: string): string {
  if (!UUID.test(tenantId)) throw new Error("A tenant container needs a tenant ID.");
  return `tenant-${tenantId.toLowerCase()}`;
}

export function documentBlobName(documentId: string): string {
  if (!UUID.test(documentId)) throw new Error("A document blob needs a document ID.");
  return `documents/${documentId.toLowerCase()}`;
}

/** The text the agent read from a job's document, which the review screen shows. */
export function textBlobName(jobId: string): string {
  if (!UUID.test(jobId)) throw new Error("A text blob needs a job ID.");
  return `texts/${jobId.toLowerCase()}.txt`;
}

/** A job's Word report. */
export function reportBlobName(jobId: string): string {
  if (!UUID.test(jobId)) throw new Error("A report blob needs a job ID.");
  return `reports/${jobId.toLowerCase()}.docx`;
}

/** The container, in the audit storage account, that holds the audit log's copy (task 14). */
export const AUDIT_COPY_CONTAINER = "audit";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The container the restore drill checks Blob Storage restores in (task 14). */
export const RESTORE_DRILL_CONTAINER = "restore-drill";

/**
 * Where a tenant's audit events copied on `day` (YYYY-MM-DD, UTC) go: one append blob.
 * `epoch` starts a fresh copy after the database is restored to an earlier point
 * (AUDIT_COPY_EPOCH; docs/operations.md); earlier epochs stay as they were.
 */
export function auditCopyBlobName(tenantId: string, day: string, epoch = 1): string {
  if (!DAY.test(day)) throw new Error("An audit copy needs a day as YYYY-MM-DD.");
  return `${auditCopyPrefix(tenantId, epoch)}${day}.jsonl`;
}

/** The prefix of every audit copy blob for one tenant, in one epoch. */
export function auditCopyPrefix(tenantId: string, epoch = 1): string {
  if (!UUID.test(tenantId)) throw new Error("An audit copy needs a tenant ID.");
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 9999)
    throw new Error("An audit copy epoch is 1 to 9999.");
  return `epoch-${epoch}/tenants/${tenantId.toLowerCase()}/`;
}

/**
 * The audit storage account (write-once container): AUDIT_STORAGE_ACCOUNT_URL with the
 * worker's own managed identity in Azure (the only one with access); locally, the same Azurite as everything else. Null if
 * neither is set, in which case nothing is copied.
 */
export function auditBlobServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BlobServiceClient | null {
  const accountUrl = env["AUDIT_STORAGE_ACCOUNT_URL"];
  if (accountUrl) {
    const clientId = env["AZURE_CLIENT_ID"];
    return new BlobServiceClient(
      accountUrl,
      clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential(),
      BLOB_OPTIONS,
    );
  }
  const connectionString = env["AZURE_STORAGE_CONNECTION_STRING"];
  return connectionString
    ? BlobServiceClient.fromConnectionString(connectionString, BLOB_OPTIONS)
    : null;
}

/**
 * In Azure: the storage account URL and the app's managed identity, with no key
 * anywhere (AZURE_STORAGE_ACCOUNT_URL, plus AZURE_CLIENT_ID for a user-assigned
 * identity). Locally: a connection string (Azurite).
 */
export function blobServiceFromEnv(env: NodeJS.ProcessEnv = process.env): BlobServiceClient {
  const accountUrl = env["AZURE_STORAGE_ACCOUNT_URL"];
  if (accountUrl) {
    // The managed identity only: no fallback to other credential sources.
    const clientId = env["AZURE_CLIENT_ID"];
    return new BlobServiceClient(
      accountUrl,
      clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential(),
      BLOB_OPTIONS,
    );
  }
  const connectionString = env["AZURE_STORAGE_CONNECTION_STRING"];
  if (!connectionString) {
    throw new Error(
      "Set AZURE_STORAGE_ACCOUNT_URL (Azure) or AZURE_STORAGE_CONNECTION_STRING (local). Copy .env.example to .env.local.",
    );
  }
  return BlobServiceClient.fromConnectionString(connectionString, BLOB_OPTIONS);
}

/** The tenant's container, created (private) on first use. */
export async function tenantContainer(
  blobs: BlobServiceClient,
  tenantId: string,
): Promise<ContainerClient> {
  const container = blobs.getContainerClient(tenantContainerName(tenantId));
  await container.createIfNotExists();
  return container;
}
