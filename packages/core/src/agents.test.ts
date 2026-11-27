import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDefinitionError,
  agentForUploads,
  findAgentsDir,
  loadAgent,
  loadAgents,
  parseDefinition,
  type LoadedAgent,
} from "./agents.ts";

const REPO_AGENTS = path.join(import.meta.dirname, "..", "..", "..", "agents");
const DOCX = readFileSync(path.join(REPO_AGENTS, "contract-summary", "template.docx"));
const SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["term"],
  properties: { term: { type: "string" } },
});

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const definition = (overrides: Record<string, unknown> = {}) => ({
  name: "demo",
  title: "Demo",
  accepts: ["pdf"],
  steps: [
    { id: "text", block: "extract-text" },
    {
      id: "fields",
      block: "extract-to-schema",
      input: "text",
      prompt: "prompt.md",
      schema: "schema.json",
    },
    { id: "report", block: "word-report", input: "fields", template: "template.docx" },
  ],
  ...overrides,
});

/** A valid agent folder "demo" under a fresh root; files can be overridden or removed (null). */
function makeAgent(
  files: Record<string, string | Buffer | null> = {},
  agentJson: unknown = definition(),
): { root: string; dir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "agents-"));
  roots.push(root);
  const dir = path.join(root, "demo");
  mkdirSync(dir);
  const all: Record<string, string | Buffer | null> = {
    "agent.json": JSON.stringify(agentJson, null, 2),
    "prompt.md": "Fill in the fields.\n",
    "schema.json": SCHEMA,
    "template.docx": DOCX,
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return { root, dir };
}

async function problems(dir: string): Promise<string[]> {
  try {
    await loadAgent(dir);
    return [];
  } catch (error) {
    if (error instanceof AgentDefinitionError) return error.problems;
    throw error;
  }
}

describe("the repository's agents", () => {
  it("all load, and the demo agent has a 12-digit version", async () => {
    const agents = await loadAgents(REPO_AGENTS);
    const demo = agents.get("contract-summary");
    expect(demo?.version).toMatch(/^[0-9a-f]{12}$/);
    expect(demo?.files).toEqual([
      "agent.json",
      "prompts/extract.md",
      "schema.json",
      "template.docx",
    ]);
  });
});

describe("agent.json checks", () => {
  const check = (raw: unknown) => {
    const result = parseDefinition(raw, "demo");
    return "problems" in result ? result.problems.join("\n") : "";
  };

  it("accepts a valid definition", () => {
    expect(check(definition())).toBe("");
  });

  it.each([
    ["not an object", [], "JSON object"],
    ["an unknown field", definition({ model: "x" }), 'unknown field "model"'],
    ["a bad name", definition({ name: "Demo Agent" }), '"name" must be'],
    ["a name that is not the folder's", definition({ name: "other" }), "the folder is"],
    ["no title", definition({ title: " " }), '"title"'],
    ["an unknown document type", definition({ accepts: ["xlsx"] }), '"accepts"'],
    ["a repeated document type", definition({ accepts: ["pdf", "pdf"] }), '"accepts"'],
    ["no steps", definition({ steps: [] }), "at least one step"],
    [
      "an unknown block",
      definition({ steps: [{ id: "a", block: "summarise" }] }),
      'unknown block "summarise"',
    ],
    ["a bad step id", definition({ steps: [{ id: "1st", block: "extract-text" }] }), '"id" must'],
    [
      "a repeated step id",
      definition({
        steps: [
          { id: "a", block: "extract-text" },
          { id: "a", block: "extract-text" },
        ],
      }),
      "used twice",
    ],
    [
      "a field the block does not use",
      definition({ steps: [{ id: "a", block: "extract-text", prompt: "p.md" }] }),
      '"prompt" does not apply',
    ],
    [
      "a missing file field",
      definition({
        steps: [
          { id: "a", block: "extract-text" },
          { id: "b", block: "word-report", input: "a" },
        ],
      }),
      'needs "template"',
    ],
    [
      "no input",
      definition({ steps: [{ id: "b", block: "word-report", template: "t.docx" }] }),
      'needs "input"',
    ],
    [
      "the output of a later step",
      definition({
        steps: [
          { id: "b", block: "word-report", input: "a", template: "t.docx" },
          { id: "a", block: "extract-text" },
        ],
      }),
      "must name an earlier step",
    ],
  ])("refuses %s", (_name, raw, message) => {
    expect(check(raw)).toContain(message);
  });
});

describe("step inputs", () => {
  it("refuses a step whose input is the wrong kind", () => {
    const result = parseDefinition(
      definition({
        steps: [
          { id: "text", block: "extract-text" },
          { id: "report", block: "word-report", input: "text", template: "t.docx" },
        ],
      }),
      "demo",
    );
    expect("problems" in result && result.problems.join("\n")).toContain(
      'word-report takes fields, but step "text" gives text',
    );
  });
});

describe("steps that use earlier fields (uses)", () => {
  const extract = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    block: "extract-to-schema",
    input: "text",
    prompt: "prompt.md",
    schema: "schema.json",
    ...extra,
  });
  const problems = (steps: unknown[]) => {
    const result = parseDefinition(definition({ steps }), "demo");
    return "problems" in result ? result.problems.join("\n") : "";
  };

  it("accepts earlier extract-to-schema steps, and keeps them in the definition", () => {
    const steps = [
      { id: "text", block: "extract-text" },
      extract("clauses"),
      extract("dates"),
      extract("assessment", { uses: ["clauses", "dates"] }),
      { id: "report", block: "word-report", input: "assessment", template: "template.docx" },
    ];
    const result = parseDefinition(definition({ steps }), "demo");
    expect(result).not.toHaveProperty("problems");
    expect("definition" in result && result.definition.steps[3]?.uses).toEqual([
      "clauses",
      "dates",
    ]);
  });

  it.each([
    ["the text step", ["text"], 'but step "text" gives text'],
    ["a report step", ["report"], 'but step "report" gives report'],
    ["a later step", ["later"], '"uses" must name earlier steps, not "later"'],
    ["an unknown step", ["nowhere"], '"uses" must name earlier steps, not "nowhere"'],
    ["the step itself", ["assessment"], '"uses" must name earlier steps, not "assessment"'],
    ["a step twice", ["clauses", "clauses"], '"uses" names a step twice'],
    ["an empty list", [], '"uses" must list one or more earlier steps by id'],
    ["a string, not a list", "clauses", '"uses" must list one or more earlier steps by id'],
    ["a list with a non-string", ["clauses", 3], '"uses" must list one or more earlier steps'],
    ["an inherited name", ["__proto__"], '"uses" must name earlier steps, not "__proto__"'],
  ])("refuses %s", (_name, uses, message) => {
    expect(
      problems([
        { id: "text", block: "extract-text" },
        extract("clauses"),
        { id: "report", block: "word-report", input: "clauses", template: "template.docx" },
        extract("assessment", { uses }),
        extract("later"),
      ]),
    ).toContain(message);
  });

  it.each([
    ["extract-text", { id: "text2", block: "extract-text", uses: ["clauses"] }],
    [
      "word-report",
      { id: "r", block: "word-report", input: "clauses", template: "t.docx", uses: ["clauses"] },
    ],
  ])("refuses uses on %s", (block, step) => {
    expect(problems([{ id: "text", block: "extract-text" }, extract("clauses"), step])).toContain(
      `"uses" does not apply to ${block}`,
    );
  });

  it("still needs input to be the text, with uses", () => {
    expect(
      problems([
        { id: "text", block: "extract-text" },
        extract("clauses"),
        extract("assessment", { input: "clauses", uses: ["clauses"] }),
      ]),
    ).toContain('extract-to-schema takes text, but step "clauses" gives fields');
  });

  it("refuses a bad uses when loading the folder", async () => {
    const { dir } = makeAgent(
      {},
      definition({
        steps: [
          { id: "text", block: "extract-text" },
          extract("assessment", { uses: ["text"] }),
        ],
      }),
    );
    await expect(loadAgent(dir)).rejects.toThrow('"uses" takes steps that give fields');
  });
});

describe("block names", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "refuses %s (inherited from Object, not a block)",
    (block) => {
      const result = parseDefinition(definition({ steps: [{ id: "a", block }] }), "demo");
      expect("problems" in result && result.problems.join("\n")).toContain("unknown block");
    },
  );
});

describe("file checks", () => {
  const withPrompt = (prompt: string) =>
    definition({
      steps: [
        { id: "text", block: "extract-text" },
        { id: "fields", block: "extract-to-schema", input: "text", prompt, schema: "schema.json" },
      ],
    });

  it("loads a valid agent", async () => {
    expect(await problems(makeAgent().dir)).toEqual([]);
  });

  it.each([
    ["a missing file", { "prompt.md": null }, undefined, "file not found"],
    ["an empty prompt", { "prompt.md": "  \n" }, undefined, "is empty"],
    ["a schema that is not JSON", { "schema.json": "{" }, undefined, "not valid JSON"],
    [
      "a schema for something other than an object",
      { "schema.json": '{"type":"string"}' },
      undefined,
      '"type": "object"',
    ],
    [
      "a schema with no fields",
      { "schema.json": '{"type":"object","properties":{}}' },
      undefined,
      '"properties"',
    ],
    [
      "a schema that is not valid JSON Schema",
      { "schema.json": '{"type":"object","properties":{"a":{"type":"nonsense"}}}' },
      undefined,
      "not a valid JSON Schema",
    ],
    [
      "a schema whose object allows other properties",
      { "schema.json": '{"type":"object","required":["a"],"properties":{"a":{"type":"string"}}}' },
      undefined,
      '"additionalProperties": false',
    ],
    [
      "a schema with an optional field in a nested object",
      {
        "schema.json": JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["parties"],
          properties: {
            parties: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name"],
                properties: { name: { type: "string" }, role: { type: "string" } },
              },
            },
          },
        }),
      },
      undefined,
      '/properties/parties/items must list every property under "required" (missing: role)',
    ],
    ["a template that is not a Word file", { "template.docx": "hello" }, undefined, "not a Word"],
    ["a path out of the folder", {}, withPrompt("../prompt.md"), "inside the agent's folder"],
    ["an absolute path", {}, withPrompt("/etc/passwd"), "relative"],
    ["a Windows drive path", {}, withPrompt("C:/prompt.md"), "relative"],
    ["backslashes", {}, withPrompt("prompts\\prompt.md"), "use /"],
    ["a path with dot segments", {}, withPrompt("./prompt.md"), "plain path"],
    ["a folder", { "sub/x.md": "x" }, withPrompt("sub"), "not a file"],
  ])("refuses %s", async (_name, files, agentJson, message) => {
    const { dir } = makeAgent(files as Record<string, string | null>, agentJson ?? definition());
    expect((await problems(dir)).join("\n")).toContain(message);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a link, even to a file in the folder",
    async () => {
      const { dir } = makeAgent({}, withPrompt("link.md"));
      symlinkSync(path.join(dir, "prompt.md"), path.join(dir, "link.md"));
      expect((await problems(dir)).join("\n")).toContain("links are not allowed");
    },
  );

  it("refuses a zip file that is not a Word document as a template", async () => {
    const zip = Buffer.from("PK\u0003\u0004 just a zip, no word part");
    expect((await problems(makeAgent({ "template.docx": zip }).dir)).join("\n")).toContain(
      "not a Word",
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a file reached through a linked folder that points outside",
    async () => {
      const { dir } = makeAgent({}, withPrompt("outside/prompt.md"));
      const elsewhere = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
      roots.push(elsewhere);
      writeFileSync(path.join(elsewhere, "prompt.md"), "Fill in.");
      symlinkSync(elsewhere, path.join(dir, "outside"));
      expect((await problems(dir)).join("\n")).toContain("inside the agent's folder");
    },
  );

  it("reads agent.json saved with a byte-order mark", async () => {
    const bom = "\uFEFF" + JSON.stringify(definition());
    expect(await problems(makeAgent({ "agent.json": bom }).dir)).toEqual([]);
  });

  it("refuses agent.json that is missing or not JSON", async () => {
    expect(await problems(makeAgent({ "agent.json": null }).dir)).toEqual(["agent.json not found"]);
    expect(await problems(makeAgent({ "agent.json": "{" }).dir)).toEqual([
      "agent.json is not valid JSON",
    ]);
  });
});

describe("versions", () => {
  const version = async (files: Record<string, string | Buffer | null> = {}, agentJson?: unknown) =>
    (await loadAgent(makeAgent(files, agentJson).dir)).version;

  it("is the same for the same files", async () => {
    expect(await version()).toBe(await version());
  });

  it("changes when a file the agent uses changes", async () => {
    expect(await version({ "prompt.md": "Fill in the fields carefully.\n" })).not.toBe(
      await version(),
    );
    expect(await version({ "schema.json": SCHEMA.replaceAll("term", "notice") })).not.toBe(
      await version(),
    );
    expect(await version({ "template.docx": Buffer.concat([DOCX, Buffer.from([0])]) })).not.toBe(
      await version(),
    );
    expect(await version({}, definition({ title: "Demo 2" }))).not.toBe(await version());
  });

  it("does not change for files the agent does not use", async () => {
    expect(await version({ "README.md": "Notes", "notes/old.md": "draft" })).toBe(await version());
  });

  it("does not change with Windows line endings in text files", async () => {
    const crlf = JSON.stringify(definition(), null, 2).replace(/\n/g, "\r\n");
    expect(await version({ "agent.json": crlf, "prompt.md": "Fill in the fields.\r\n" })).toBe(
      await version(),
    );
  });

  it("tells apart files that are not valid UTF-8", async () => {
    const a = await version({ "prompt.md": Buffer.from([0x41, 0xff]) });
    const b = await version({ "prompt.md": Buffer.from([0x41, 0xfe]) });
    expect(a).not.toBe(b);
  });

  it("does not change with a byte-order mark in agent.json", async () => {
    expect(await version({ "agent.json": "\uFEFF" + JSON.stringify(definition(), null, 2) })).toBe(
      await version(),
    );
  });

  it("keeps the content it hashed, for the steps to run", async () => {
    const agent = await loadAgent(makeAgent({ "prompt.md": "Line one\r\nLine two\r\n" }).dir);
    expect(agent.contents.get("prompt.md")?.toString()).toBe("Line one\nLine two\n");
    expect(agent.contents.get("template.docx")?.equals(DOCX)).toBe(true);
    expect([...agent.contents.keys()].sort()).toEqual(agent.files);
  });

  it("changes when a file is renamed, even with the same content", async () => {
    const renamed = definition({
      steps: [
        { id: "text", block: "extract-text" },
        {
          id: "fields",
          block: "extract-to-schema",
          input: "text",
          prompt: "p2.md",
          schema: "schema.json",
        },
        { id: "report", block: "word-report", input: "fields", template: "template.docx" },
      ],
    });
    const original = await loadAgent(makeAgent().dir);
    const moved = await loadAgent(makeAgent({ "p2.md": "Fill in the fields.\n" }, renamed).dir);
    // agent.json differs too, but the hash covers paths as well as contents.
    expect(moved.version).not.toBe(original.version);
  });
});

describe("the registry", () => {
  it("refuses to load if any agent is not valid", async () => {
    const { root } = makeAgent({ "prompt.md": null });
    await expect(loadAgents(root)).rejects.toThrow(AgentDefinitionError);
  });

  it.skipIf(process.platform === "win32")("refuses an agent folder that is a link", async () => {
    const { dir } = makeAgent();
    const other = mkdtempSync(path.join(tmpdir(), "agents-other-"));
    roots.push(other);
    symlinkSync(dir, path.join(other, "demo"));
    await expect(loadAgents(other)).rejects.toThrow("is a link");
  });

  it("skips hidden folders", async () => {
    const { root } = makeAgent();
    mkdirSync(path.join(root, ".cache"));
    expect([...(await loadAgents(root)).keys()]).toEqual(["demo"]);
  });

  it("finds the agents folder from AGENTS_DIR, or above the working directory", () => {
    const { root } = makeAgent();
    expect(findAgentsDir({ AGENTS_DIR: root })).toBe(root);
    const nested = path.join(path.dirname(root), path.basename(root), "demo");
    // No "agents" folder above a temp folder: it says so.
    expect(() => findAgentsDir({}, nested)).toThrow("No agents folder found");
    expect(findAgentsDir({}, path.join(REPO_AGENTS, "..", "packages", "core"))).toBe(REPO_AGENTS);
  });

  it("gives uploads the configured agent, by default contract-summary", () => {
    const fake = (name: string) => [name, { definition: { name } } as LoadedAgent] as const;
    const agents = new Map([fake("contract-summary"), fake("other")]);
    expect(agentForUploads(agents, {}).definition.name).toBe("contract-summary");
    expect(agentForUploads(agents, { AGENT_FOR_UPLOADS: "other" }).definition.name).toBe("other");
    expect(() => agentForUploads(agents, { AGENT_FOR_UPLOADS: "missing" })).toThrow(
      "not in the agents folder",
    );
  });
});
