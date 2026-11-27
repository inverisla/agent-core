// Sets up the demo (task 15): a tenant, "Demo Ltd", with an admin and a user, both demo
// agents assigned to it (the contract summary and the risk review, task 17), and three of
// the sample contracts uploaded for a summary, so their jobs run as soon as the worker
// starts (`pnpm dev`). Uses the app's own code, so everything is recorded as it would be: the
// audit log, the documents, the jobs. Safe to run again: it reuses the tenant, and uploads
// only if the tenant has no documents yet. Refuses to run against anything but local
// services (scripts/check-services.ts checks them all first, before migrating). Exits 1,
// saying how to start again, if anything fails. See docs/demo.md.
import { readFileSync } from "node:fs";
import path from "node:path";
import { agentRegistry } from "@agent-core/core/agents";
import { blobServiceFromEnv } from "@agent-core/core/storage";
import {
  addTenantUser,
  createTenantDatabase,
  createTenantWithAdmin,
  listTenantUsers,
  parseContextKey,
  setTenantAgents,
  SETUP_ACTOR,
} from "@agent-core/db";
import { intakeDocument, maxUploadBytes } from "../lib/documents/intake.ts";
import { listDocuments } from "../lib/documents/list.ts";
import { startDocumentJob } from "../lib/jobs/start.ts";

const SLUG = "demo-ltd";
const ADMIN = "admin@demo-ltd.example";
const USER = "reviewer@demo-ltd.example";
const SAMPLES = ["01-office-supplies.pdf", "02-it-support.docx", "04-catering-guarantee.pdf"];
/** The agents Demo Ltd may use, so the upload form offers a choice; the samples get the first. */
const AGENTS = ["contract-summary", "contract-risk"];
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local first.`);
  return value;
}

function local(url: string): boolean {
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const databaseUrl = need("DATABASE_URL");
const authUrl = need("AUTH_URL");
if (!local(databaseUrl) || !local(authUrl)) {
  console.error("pnpm demo only sets up a local demo: DATABASE_URL and AUTH_URL must be local.");
  process.exit(1);
}

const db = createTenantDatabase(databaseUrl, {
  contextKey: parseContextKey(need("TENANT_CONTEXT_KEY")),
  maxConnections: 2,
});
try {
  let tenantId = await db.tenantIdForSlug(SLUG);
  if (tenantId) {
    console.log(`demo: tenant /t/${SLUG} already exists; reusing it`);
  } else {
    tenantId = await createTenantWithAdmin(
      db,
      { name: "Demo Ltd", slug: SLUG, adminEmail: ADMIN },
      SETUP_ACTOR,
    );
    console.log(`demo: created tenant /t/${SLUG} with admin ${ADMIN}`);
  }
  const users = await listTenantUsers(db, tenantId);
  if (!users.some((u) => u.email === USER && !u.removedAt)) {
    await addTenantUser(db, tenantId, { email: USER, role: "tenant_user" }, SETUP_ACTOR);
    console.log(`demo: added user ${USER}`);
  }
  const registry = await agentRegistry(process.env);
  const agents = AGENTS.map((name) => {
    const agent = registry.get(name);
    if (!agent) throw new Error(`The agents folder has no ${name} agent.`);
    return agent;
  });
  // Saving the same agents again records nothing, so running the demo again is quiet.
  await setTenantAgents(db, tenantId, AGENTS, SETUP_ACTOR);
  console.log(`demo: assigned the agents ${AGENTS.join(" and ")}`);
  const admin = (await listTenantUsers(db, tenantId)).find((u) => u.email === ADMIN);
  if ((await listDocuments(db, tenantId)).length > 0) {
    console.log("demo: the tenant already has documents; not uploading the samples again");
  } else {
    const samples = path.join(import.meta.dirname, "..", "..", "..", "samples", "files");
    const blobs = blobServiceFromEnv();
    for (const file of SAMPLES) {
      const result = await intakeDocument({
        db,
        blobs,
        tenantId,
        userId: admin?.userId ?? "",
        filename: file,
        bytes: readFileSync(path.join(samples, file)),
        maxBytes: maxUploadBytes(),
      });
      if (!result.ok) throw new Error(`${file} was refused: ${result.reason}`);
      const job = await startDocumentJob(db, tenantId, result.document.documentId, agents[0]);
      if (!job.queued) throw new Error(`${file} was uploaded, but Temporal did not take its job.`);
      console.log(`demo: uploaded ${file}`);
    }
  }
  // Where `pnpm dev` writes emails (lib/email/send.ts), from the repository root.
  const root = path.join(import.meta.dirname, "..", "..", "..");
  const outbox = path.relative(
    root,
    process.env["DEV_OUTBOX_DIR"] ?? path.join(import.meta.dirname, "..", ".dev-outbox"),
  );
  console.log(`
Demo ready. Next:
  1. pnpm dev                      (web app and worker; the uploaded contracts are processed)
  2. Open ${new URL(`/t/${SLUG}/sign-in`, authUrl)}
     and ask for a sign-in link for ${ADMIN}. The email is a file in ${outbox}/
  3. Follow docs/demo.md. The operator console is at ${new URL("/operator/sign-in", authUrl)}
     ("Sign in as the local operator").`);
} catch (error) {
  console.error(`
pnpm demo failed: ${error instanceof Error ? error.message : String(error)}
Start again from scratch: docker compose down -v, docker compose up -d --wait, pnpm demo.`);
  process.exitCode = 1;
} finally {
  await db.close();
  // Temporal's client keeps the process alive otherwise.
  process.exit(process.exitCode ?? 0);
}
