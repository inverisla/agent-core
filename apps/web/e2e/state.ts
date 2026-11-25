import { readFileSync } from "node:fs";
import path from "node:path";

export const STATE_FILE = path.join(import.meta.dirname, ".state", "run.json");
export const PORT = 3100;
export const BASE_URL = `http://localhost:${PORT}`;
/** The second agent e2e runs have besides the demo agent (a copy of it). */
export const E2E_SECOND_AGENT = "second-agent";

export interface Persona {
  userId: string;
  email: string;
}

export interface RunState {
  authSecret: string;
  outboxDir: string;
  agentsDir: string;
  appUrl: string;
  adminUrl: string;
  contextKeyBase64: string;
  serverPid: number;
  workerPid: number;
  /** This run's own Temporal task queue (and so its own schedules). */
  taskQueue: string;
  /** A job of tenant A's, for the role matrix. */
  aJobId: string;
  /** A tenant A job waiting for review (task 11). */
  reviewJobId: string;
  a: { tenantId: string; slug: string; admin: Persona; user: Persona; removed: Persona };
  b: { tenantId: string; slug: string; admin: Persona; user: Persona };
  g: { tenantId: string; slug: string; admin: Persona; newAdmin: Persona; user: Persona };
}

export function readState(): RunState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunState;
}

/** Azurite's published development account (not a secret): the e2e run's Blob Storage. */
export const AZURITE =
  process.env["AZURE_STORAGE_CONNECTION_STRING"] ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
