// Review S7: in infra/azure/main.bicep, only the worker's identity may reach the audit
// log's write-once copy or the model, and the worker runs as that identity. A change that
// gave the web app's identity either again would fail here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bicep = readFileSync(
  path.join(import.meta.dirname, "..", "infra", "azure", "main.bicep"),
  "utf8",
);

/** Each top-level resource or module block, by its symbolic name. */
function blocks(): Map<string, string> {
  const found = new Map<string, string>();
  const starts = [...bicep.matchAll(/^(?:resource|module) (\w+) /gm)];
  starts.forEach((m, i) => {
    const end = starts[i + 1]?.index ?? bicep.length;
    found.set(m[1] ?? "", bicep.slice(m.index, end));
  });
  return found;
}

describe("who may reach what in Azure (review S7)", () => {
  const all = blocks();
  const using = (text: RegExp) => [...all].filter(([, b]) => text.test(b)).map(([n]) => n);

  it("grants the web app's identity only its secrets, the documents and email", () => {
    // Anything else given to appIdentity (a role on the audit account or the model, a new
    // role assignment, a module) must be added here deliberately.
    expect(using(/appIdentity\.properties\.principalId/).sort()).toEqual(
      ["appBlobAccess", "appSecretAccess", "email"].sort(),
    );
    expect(all.get("appBlobAccess")).toMatch(/scope: storage\b/);
  });

  it("gives only the worker's identity a role on the audit account, at any level", () => {
    const onAudit = [...all.values()].filter((b) =>
      /roleAssignments[\s\S]*scope: audit\w*/.test(b),
    );
    expect(onAudit.length).toBeGreaterThan(0);
    for (const b of onAudit) {
      expect(b).toContain("workerIdentity.properties.principalId");
      expect(b).not.toMatch(/appIdentity|opsIdentity/);
    }
  });

  it("gives only the worker's identity the model", () => {
    expect(all.get("openai")).toContain("principalId: workerIdentity.properties.principalId");
  });

  it("points only the worker at the audit account, and runs it as its own identity", () => {
    expect(using(/AUDIT_STORAGE_ACCOUNT_URL/)).toEqual(["worker"]);
    const worker = all.get("worker") ?? "";
    expect(worker).toContain("workerIdentity.id");
    expect(worker).not.toMatch(/appIdentity/);
  });

  it("removes the web app's earlier roles on every deploy, fast or full", () => {
    const deploy = readFileSync(
      path.join(import.meta.dirname, "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    const step = deploy.split("- name: ").find((s) => s.startsWith("Remove the web app's access"));
    expect(step).toBeDefined();
    expect(step).not.toMatch(/^\s*if:/m);
    expect(step).toContain("ba92f5b4-2d11-453d-a403-e96b0029c9fe");
    expect(step).toContain("5e0bd9bd-7b93-4f28-af87-19fc36ad61bd");
    // Nothing in it may need Microsoft Graph (--assignee, even -object-id, is refused to
    // be safe; filled-in names; az ad): a Graph token needs a fresh federated token.
    const commands = (step ?? "").replace(/^\s*#.*$/gm, "").replace(/\\\n/g, " ");
    expect(commands).not.toMatch(/--assignee|\baz ad\b/);
    const lists = commands.match(/az role assignment list[^\n]*/g) ?? [];
    expect(lists).not.toEqual([]);
    for (const list of lists) {
      expect(list).toContain("--fill-principal-name false");
      // Only the web app's own assignments: the worker holds the same roles there.
      expect(list).toContain(`--query "[?principalId=='$app'].id"`);
    }
  });

  it("signs in again before the steps that need a new Azure token late in a deploy", () => {
    const deploy = readFileSync(
      path.join(import.meta.dirname, "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    const names = [...deploy.matchAll(/^ {6}- (?:name: (.*)|uses: )/gm)].map((m) => m[1] ?? "");
    const signInBefore = (step: string) => {
      const at = names.findIndex((n) => n.startsWith(step));
      expect(at).toBeGreaterThan(0);
      expect(names[at - 1]).toMatch(/^Sign in to Azure/);
    };
    signInBefore("Build and push images");
    signInBefore("Remove the web app's access");
  });
});
