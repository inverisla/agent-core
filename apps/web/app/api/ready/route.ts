import { agentForUploads, agentRegistry, describeAgentError } from "@agent-core/core/agents";
import { db } from "../../../lib/server/db.ts";

export const dynamic = "force-dynamic";

/**
 * Whether the app can use its database as the app role (the role check, the signed
 * tenant context setup and the slug lookup function, which only exists once migrated),
 * and whether the agents load.
 * The deploy checks this; container probes use /api/health, which does not touch the
 * database, so a database blip does not restart the app.
 */
export async function GET(): Promise<Response> {
  try {
    await db().tenantIdForSlug("deploy-check");
    // And that the agents load, including the one uploads run.
    agentForUploads(await agentRegistry(process.env), process.env);
    return Response.json({ status: "ready" });
  } catch (error) {
    console.error("not ready:", describeAgentError(error));
    return Response.json({ status: "not ready" }, { status: 503 });
  }
}
