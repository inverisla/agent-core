// The restore drill's checks (task 14), run inside Azure's network by the restore-check
// job, which .github/workflows/restore-drill.yml starts after restoring Postgres to a
// new, temporary server. Settings come from the environment:
//   DATABASE_ADMIN_URL, DATABASE_URL, TENANT_CONTEXT_KEY   the live database (as for the apps)
//   RESTORE_HOST    the restored server's host name; the same users and database on it
//   RESTORE_POINT   the time it was restored to (ISO 8601)
//   AZURE_STORAGE_ACCOUNT_URL, AZURE_CLIENT_ID             documents and reports storage
// Prints one line per check and exits 1 if any failed. It never prints a URL or password.
import { blobServiceFromEnv, RESTORE_DRILL_CONTAINER } from "@agent-core/core/storage";
import { checkRestore, parseContextKey } from "@agent-core/db";

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function onHost(url: string, host: string): string {
  const u = new URL(url);
  u.hostname = host;
  return u.toString();
}

/**
 * Documents can be got back: an overwritten one from its earlier version, and a deleted one
 * from its last version. (With versioning on, a delete keeps the blob as a previous
 * version; undelete is for accounts without versioning.)
 */
async function checkBlobRestore(): Promise<string[]> {
  const container = blobServiceFromEnv().getContainerClient(RESTORE_DRILL_CONTAINER);
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient("probe.txt");
  const first = `first version ${new Date().toISOString()}`;
  const second = `second version ${new Date().toISOString()}`;
  const v1 = (await blob.upload(first, Buffer.byteLength(first))).versionId;
  const v2 = (await blob.upload(second, Buffer.byteLength(second))).versionId;
  if (!v1 || !v2) return ["FAIL blob versions are off: no version ID on upload"];
  const lines: string[] = [];
  const earlier = (await blob.withVersion(v1).downloadToBuffer()).toString("utf8");
  lines.push(
    earlier === first
      ? "ok   an overwritten blob's earlier version can be read back"
      : "FAIL an overwritten blob's earlier version did not match",
  );
  await blob.delete();
  if (await blob.exists()) return [...lines, "FAIL a deleted blob was still there"];
  const kept = (await blob.withVersion(v2).downloadToBuffer()).toString("utf8");
  await blob.upload(kept, Buffer.byteLength(kept));
  const back = (await blob.downloadToBuffer()).toString("utf8");
  lines.push(
    back === second
      ? "ok   a deleted blob can be restored from its last version"
      : "FAIL a deleted blob could not be restored from its last version",
  );
  return lines;
}

try {
  const host = need("RESTORE_HOST").toLowerCase();
  if (!HOST.test(host)) throw new Error("RESTORE_HOST is not a host name.");
  const restorePoint = new Date(need("RESTORE_POINT"));
  if (Number.isNaN(restorePoint.getTime())) throw new Error("RESTORE_POINT is not a time.");
  const adminUrl = need("DATABASE_ADMIN_URL");
  const appUrl = need("DATABASE_URL");
  const result = await checkRestore({
    source: { adminUrl, appUrl },
    restored: { adminUrl: onHost(adminUrl, host), appUrl: onHost(appUrl, host) },
    contextKey: parseContextKey(need("TENANT_CONTEXT_KEY")),
    restorePoint,
  });
  const lines = [...result.lines, ...(await checkBlobRestore())];
  for (const line of lines) console.log(line);
  const ok = lines.every((l) => !l.startsWith("FAIL"));
  console.log(
    `restore drill: ${ok ? "PASSED" : "FAILED"} (restored to ${restorePoint.toISOString()})`,
  );
  process.exit(ok ? 0 : 1);
} catch (error) {
  // The first line only: a driver error can carry connection details further down.
  console.error(
    `restore drill: FAILED: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`,
  );
  process.exit(1);
}
