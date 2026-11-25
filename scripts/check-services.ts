// Runs first in `pnpm demo`, before it migrates anything. Refuses unless every service in
// .env.local is on this machine (pnpm demo only sets up a local demo), then checks the
// services `docker compose up -d --wait` starts are reachable, so a missing one gives one
// clear line, not a stack trace.
// eslint-disable-next-line no-restricted-imports -- only opens a socket to see a local port answers
import { connect } from "node:net";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

function localUrl(url: string): boolean {
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The settings in `env` that point anywhere but this machine. Unset ones are fine. */
export function nonLocalSettings(env: Record<string, string | undefined>): string[] {
  const blobs = env["AZURE_STORAGE_CONNECTION_STRING"];
  const blobEndpoint = blobs ? /BlobEndpoint=([^;]+)/.exec(blobs)?.[1] : undefined;
  const local: Record<string, boolean> = {
    DATABASE_URL: !env["DATABASE_URL"] || localUrl(env["DATABASE_URL"]),
    DATABASE_ADMIN_URL: !env["DATABASE_ADMIN_URL"] || localUrl(env["DATABASE_ADMIN_URL"]),
    AUTH_URL: !env["AUTH_URL"] || localUrl(env["AUTH_URL"]),
    TEMPORAL_ADDRESS: !env["TEMPORAL_ADDRESS"] || localUrl(`http://${env["TEMPORAL_ADDRESS"]}`),
    // Blob Storage only through Azurite: no account URL, and a local blob endpoint.
    AZURE_STORAGE_ACCOUNT_URL: !env["AZURE_STORAGE_ACCOUNT_URL"],
    AZURE_STORAGE_CONNECTION_STRING:
      !blobs || (blobEndpoint !== undefined && localUrl(blobEndpoint)),
  };
  return Object.keys(local).filter((name) => !local[name]);
}

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 2000 });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

if (import.meta.main) {
  const remote = nonLocalSettings(process.env);
  if (remote.length > 0) {
    console.error(
      `pnpm demo only sets up a local demo, but these are not local: ${remote.join(", ")}.`,
    );
    console.error("Use the values from .env.example.");
    process.exit(1);
  }
  const missing: string[] = [];
  for (const s of [
    { name: "Postgres", port: 5433 },
    { name: "Temporal", port: 7233 },
    { name: "Azurite (Blob Storage)", port: 10000 },
  ])
    if (!(await reachable(s.port))) missing.push(`${s.name} (port ${s.port})`);
  if (missing.length > 0) {
    console.error(`Not running: ${missing.join(", ")}.`);
    console.error("Start Docker, then run: docker compose up -d --wait");
    process.exit(1);
  }
}
