// Agents are defined in files: agents/<name>/agent.json, plus the prompts, output schema
// and report template it points at. This module reads and checks them, and gives each
// agent a version: a hash of exactly the files it uses, so any change to what the agent
// does is a new version, and nothing else is.
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { statSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

/** The building blocks a step can use (task 9 implements them) and what each needs. */
export const AGENT_BLOCKS = {
  "extract-text": { files: [], takesInput: false, input: null, output: "text" },
  "extract-to-schema": {
    files: ["prompt", "schema"],
    takesInput: true,
    input: "text",
    output: "fields",
  },
  "word-report": { files: ["template"], takesInput: true, input: "fields", output: "report" },
} as const satisfies Record<
  string,
  { files: readonly FileField[]; takesInput: boolean; input: StepData | null; output: StepData }
>;

/** What a step produces, and so what a later step can take as its input. */
export type StepData = "text" | "fields" | "report";

export type AgentBlock = keyof typeof AGENT_BLOCKS;
type FileField = "prompt" | "schema" | "template";
const FILE_FIELDS: readonly FileField[] = ["prompt", "schema", "template"];
export const DOCUMENT_TYPES = ["pdf", "docx"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface AgentStep {
  id: string;
  block: AgentBlock;
  /** The id of an earlier step whose output this step takes. */
  input?: string;
  prompt?: string;
  schema?: string;
  template?: string;
}

export interface AgentDefinition {
  name: string;
  title: string;
  accepts: DocumentType[];
  steps: AgentStep[];
}

export interface LoadedAgent {
  definition: AgentDefinition;
  /** First 12 hex digits of the SHA-256 of agent.json and every file it references. */
  version: string;
  /** The agent's folder. */
  dir: string;
  /** agent.json and the files it references, relative to dir, sorted. */
  files: string[];
  /**
   * Each file's content exactly as hashed (text files with Unix line endings), so the
   * steps can run what the version describes, even if the files change on disk later.
   */
  contents: ReadonlyMap<string, Buffer>;
}

export class AgentDefinitionError extends Error {
  readonly agent: string;
  readonly problems: string[];

  constructor(agent: string, problems: string[]) {
    super(`agent "${agent}" is not valid:\n- ${problems.join("\n- ")}`);
    this.name = "AgentDefinitionError";
    this.agent = agent;
    this.problems = problems;
  }
}

/** Setting-up problems: no agents folder, or AGENT_FOR_UPLOADS naming no agent. */
export class AgentSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSetupError";
  }
}

/**
 * What to log for an error: the message for agent errors (it names only the files and
 * settings an operator wrote), otherwise just the error's name.
 */
export function describeAgentError(error: unknown): string {
  if (error instanceof AgentDefinitionError || error instanceof AgentSetupError) {
    return error.message;
  }
  return error instanceof Error ? error.name : "unknown error";
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const STEP_ID = /^[a-z][a-z0-9-]{0,39}$/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks agent.json's shape. Returns the definition, or the list of problems. Files it
 * names are checked separately (checkFiles), since that needs the disk.
 */
export function parseDefinition(
  raw: unknown,
  folderName: string,
): { definition: AgentDefinition } | { problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(raw)) return { problems: ["agent.json must hold a JSON object"] };
  for (const key of Object.keys(raw)) {
    if (!["name", "title", "accepts", "steps"].includes(key))
      problems.push(`unknown field "${key}"`);
  }
  const { name, title, accepts, steps } = raw;
  if (typeof name !== "string" || !NAME.test(name)) {
    problems.push('"name" must be lower-case letters, digits and hyphens (up to 40 characters)');
  } else if (name !== folderName) {
    problems.push(`"name" is "${name}" but the folder is "${folderName}"`);
  }
  if (typeof title !== "string" || title.trim() === "") problems.push('"title" must be some text');
  if (
    !Array.isArray(accepts) ||
    accepts.length === 0 ||
    !accepts.every((t) => (DOCUMENT_TYPES as readonly unknown[]).includes(t)) ||
    new Set(accepts).size !== accepts.length
  ) {
    problems.push(`"accepts" must list document types from: ${DOCUMENT_TYPES.join(", ")}`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push('"steps" must list at least one step');
    return { problems };
  }
  const seen = new Map<string, AgentBlock>();
  steps.forEach((step: unknown, i) => {
    const where = `step ${i + 1}`;
    if (!isRecord(step)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { id, block, input } = step;
    const label = typeof id === "string" ? `step "${id}"` : where;
    if (typeof id !== "string" || !STEP_ID.test(id)) {
      problems.push(`${where}: "id" must start with a letter: lower-case letters, digits, hyphens`);
    } else if (seen.has(id)) {
      problems.push(`${label} is used twice`);
    }
    if (typeof block !== "string" || !Object.hasOwn(AGENT_BLOCKS, block)) {
      problems.push(
        `${label}: unknown block "${String(block)}" (known: ${Object.keys(AGENT_BLOCKS).join(", ")})`,
      );
    } else {
      const spec = AGENT_BLOCKS[block as AgentBlock];
      for (const key of Object.keys(step)) {
        const allowed = ["id", "block", ...(spec.takesInput ? ["input"] : []), ...spec.files];
        if (!allowed.includes(key)) problems.push(`${label}: "${key}" does not apply to ${block}`);
      }
      for (const field of spec.files) {
        if (typeof step[field] !== "string" || step[field] === "") {
          problems.push(`${label}: ${block} needs "${field}" (a file in the agent's folder)`);
        }
      }
      if (spec.takesInput) {
        if (typeof input !== "string")
          problems.push(`${label}: ${block} needs "input" (an earlier step)`);
        else if (!seen.has(input))
          problems.push(`${label}: "input" must name an earlier step, not "${input}"`);
        else {
          const given = AGENT_BLOCKS[seen.get(input) as AgentBlock].output;
          if (given !== spec.input) {
            problems.push(
              `${label}: ${block} takes ${spec.input}, but step "${input}" gives ${given}`,
            );
          }
        }
      }
    }
    if (typeof id === "string" && typeof block === "string" && Object.hasOwn(AGENT_BLOCKS, block)) {
      seen.set(id, block as AgentBlock);
    }
  });
  if (problems.length > 0) return { problems };
  return { definition: raw as unknown as AgentDefinition };
}

/** A file reference as written in agent.json: a relative path that stays in the folder. */
function badPath(ref: string): string | null {
  if (ref.includes("\\")) return "use / in file paths";
  if (path.posix.isAbsolute(ref) || /^[A-Za-z]:/.test(ref))
    return "must be relative to the agent's folder";
  const normal = path.posix.normalize(ref);
  if (normal !== ref || normal === "." || normal.startsWith("../") || normal === "..") {
    return "must be a plain path inside the agent's folder";
  }
  return null;
}

function referencedFiles(
  definition: AgentDefinition,
): { step: string; field: FileField; ref: string }[] {
  return definition.steps.flatMap((step) =>
    FILE_FIELDS.flatMap((field) =>
      step[field] ? [{ step: step.id, field, ref: step[field] }] : [],
    ),
  );
}

/**
 * Text files (agent.json, prompts, schemas) as hashed and run: without a UTF-8 byte-order
 * mark, and with Windows line endings (CR LF) as Unix ones, so a checkout on any machine
 * gives the same version. The bytes are not decoded, so different files never look alike.
 */
export function normaliseText(bytes: Buffer): Buffer {
  const body = bytes.subarray(0, 3).equals(BOM) ? bytes.subarray(3) : bytes;
  const out = Buffer.alloc(body.length);
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0d && body[i + 1] === 0x0a) continue;
    out[n++] = body[i] as number;
  }
  return out.subarray(0, n);
}

/**
 * Checks each referenced file exists, stays in the folder, and looks like what it should
 * be. Returns the problems, and each good file's content as it is to be hashed.
 */
async function checkFiles(
  dir: string,
  definition: AgentDefinition,
): Promise<{ problems: string[]; contents: Map<string, Buffer> }> {
  const problems: string[] = [];
  const contents = new Map<string, Buffer>();
  const root = await realpath(dir);
  for (const { step, field, ref } of referencedFiles(definition)) {
    const label = `step "${step}" ${field} "${ref}"`;
    const pathProblem = badPath(ref);
    if (pathProblem) {
      problems.push(`${label}: ${pathProblem}`);
      continue;
    }
    const full = path.join(dir, ...ref.split("/"));
    const info = await lstat(full).catch(() => null);
    if (!info) {
      problems.push(`${label}: file not found`);
      continue;
    }
    if (info.isSymbolicLink()) {
      problems.push(`${label}: links are not allowed; put the file itself in the folder`);
      continue;
    }
    if (!info.isFile()) {
      problems.push(`${label}: not a file`);
      continue;
    }
    const real = await realpath(full);
    if (!real.startsWith(root + path.sep)) {
      problems.push(`${label}: must be inside the agent's folder`);
      continue;
    }
    const raw = await readFile(full);
    const bytes = field === "template" ? raw : normaliseText(raw);
    contents.set(ref, bytes);
    if (field === "prompt" && bytes.toString("utf8").trim() === "")
      problems.push(`${label}: is empty`);
    if (field === "schema") {
      const schemaProblem = checkSchema(bytes.toString("utf8"));
      if (schemaProblem) problems.push(`${label}: ${schemaProblem}`);
    }
    // A .docx is a zip file (starting "PK") holding word/document.xml.
    if (
      field === "template" &&
      !(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes.includes("word/document.xml"))
    ) {
      problems.push(`${label}: is not a Word (.docx) file`);
    }
  }
  return { problems, contents };
}

/**
 * Where a schema breaks the structured-output rules both providers apply (Azure OpenAI's
 * strict mode): every object closes its properties ("additionalProperties": false) and
 * lists them all under "required" (a field that may be absent is a nullable type instead).
 */
function strictModeProblem(node: unknown, at: string): string | null {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      const problem = strictModeProblem(item, `${at}/${i}`);
      if (problem) return problem;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  const properties = node["properties"];
  if (isRecord(properties)) {
    const where = at === "" ? "the top-level object" : `the object at ${at}`;
    if (node["additionalProperties"] !== false)
      return `${where} must set "additionalProperties": false`;
    const required = Array.isArray(node["required"]) ? node["required"] : [];
    const missing = Object.keys(properties).filter((key) => !required.includes(key));
    if (missing.length > 0)
      return `${where} must list every property under "required" (missing: ${missing.join(", ")}); make a field that may be absent nullable instead`;
  }
  for (const key of ["properties", "items", "$defs", "anyOf"]) {
    const child = node[key];
    const children =
      key === "properties" || key === "$defs" ? (isRecord(child) ? child : {}) : null;
    const problem = children
      ? (Object.entries(children)
          .map(([name, value]) => strictModeProblem(value, `${at}/${key}/${name}`))
          .find((p) => p !== null) ?? null)
      : strictModeProblem(child, `${at}/${key}`);
    if (problem) return problem;
  }
  return null;
}

/**
 * An output schema: a valid JSON Schema (draft 2020-12, the one extract-to-schema checks
 * answers against) for an object with named properties, within the structured-output
 * rules (see strictModeProblem).
 */
function checkSchema(text: string): string | null {
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    return "is not valid JSON";
  }
  if (!isRecord(schema) || schema["type"] !== "object")
    return 'must be a JSON Schema with "type": "object"';
  const properties = schema["properties"];
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    return 'must list the fields to extract under "properties"';
  }
  try {
    new Ajv2020({ strict: false }).compile(schema);
  } catch (error) {
    // Ajv's message describes the schema (which the operator wrote), not any data.
    return `is not a valid JSON Schema: ${error instanceof Error ? error.message : "unknown problem"}`;
  }
  return strictModeProblem(schema, "");
}

/**
 * The version: a hash over each file's path, length and content, in path order. Paths
 * cannot contain NUL, so the framing cannot be read two ways.
 */
export function agentVersion(contents: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const file of [...contents.keys()].sort()) {
    const bytes = contents.get(file) as Buffer;
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 12);
}

/** Reads and checks one agent's folder. Throws AgentDefinitionError if anything is wrong. */
export async function loadAgent(dir: string): Promise<LoadedAgent> {
  const folderName = path.basename(dir);
  let agentJson: Buffer;
  try {
    agentJson = normaliseText(await readFile(path.join(dir, "agent.json")));
  } catch {
    throw new AgentDefinitionError(folderName, ["agent.json not found"]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(agentJson.toString("utf8"));
  } catch {
    throw new AgentDefinitionError(folderName, ["agent.json is not valid JSON"]);
  }
  const parsed = parseDefinition(raw, folderName);
  if ("problems" in parsed) throw new AgentDefinitionError(folderName, parsed.problems);
  const { problems, contents } = await checkFiles(dir, parsed.definition);
  if (problems.length > 0) throw new AgentDefinitionError(folderName, problems);
  contents.set("agent.json", agentJson);
  return {
    definition: parsed.definition,
    version: agentVersion(contents),
    dir,
    files: [...contents.keys()].sort(),
    contents,
  };
}

/** Every agent under root (one folder each). Throws if any of them is not valid. */
export async function loadAgents(root: string): Promise<Map<string, LoadedAgent>> {
  const entries = await readdir(root, { withFileTypes: true });
  const agents = new Map<string, LoadedAgent>();
  for (const entry of entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      throw new AgentDefinitionError(entry.name, [
        "the agent's folder is a link; put the folder itself under agents/",
      ]);
    }
    const agent = await loadAgent(path.join(root, entry.name));
    agents.set(agent.definition.name, agent);
  }
  return agents;
}

const isDirectory = (p: string) =>
  statSync(/*turbopackIgnore: true*/ p, { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * The agents folder: AGENTS_DIR if set (the images set it), otherwise the nearest
 * "agents" folder at or above the working directory (the repository root, locally).
 * The turbopackIgnore comments stop Next.js tracing this lookup, which would otherwise
 * copy the whole web app into its build output.
 */
export function findAgentsDir(env: NodeJS.ProcessEnv, from: string = process.cwd()): string {
  const configured = env["AGENTS_DIR"];
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured);
  for (let dir = path.resolve(/*turbopackIgnore: true*/ from); ; dir = path.dirname(dir)) {
    const candidate = path.join(/*turbopackIgnore: true*/ dir, "agents");
    if (isDirectory(candidate)) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  throw new AgentSetupError(`No agents folder found at or above ${from}. Set AGENTS_DIR.`);
}

const DEFAULT_UPLOAD_AGENT = "contract-summary";

/** The agent every upload runs (one per deployment for now; see docs/PLAN.md task 12b). */
export function agentForUploads(
  agents: Map<string, LoadedAgent>,
  env: NodeJS.ProcessEnv,
): LoadedAgent {
  const name = env["AGENT_FOR_UPLOADS"] || DEFAULT_UPLOAD_AGENT;
  const agent = agents.get(name);
  if (!agent) {
    throw new AgentSetupError(
      `AGENT_FOR_UPLOADS names "${name}", which is not in the agents folder.`,
    );
  }
  return agent;
}

const cached = globalThis as unknown as { agentCoreAgents?: Promise<Map<string, LoadedAgent>> };

/** The agents, loaded once per process. A failed load is not cached, so it is retried. */
export function agentRegistry(env: NodeJS.ProcessEnv): Promise<Map<string, LoadedAgent>> {
  cached.agentCoreAgents ??= Promise.resolve().then(() => loadAgents(findAgentsDir(env)));
  cached.agentCoreAgents.catch(() => {
    delete cached.agentCoreAgents;
  });
  return cached.agentCoreAgents;
}

/**
 * The JSON Schema for the fields an agent produces: its last extract-to-schema step's
 * schema, or null if it has none. Read from the contents loaded with the agent, so it is
 * the version the job ran.
 */
export function fieldsSchema(agent: LoadedAgent): Record<string, unknown> | null {
  const step = agent.definition.steps.findLast((s) => s.block === "extract-to-schema");
  const file = step && "schema" in step ? agent.contents.get(String(step.schema)) : undefined;
  return file ? (JSON.parse(file.toString("utf8")) as Record<string, unknown>) : null;
}

const fieldValidators = new Map<string, ReturnType<Ajv2020["compile"]>>();

/**
 * What is wrong with `fields` against the schema (paths and rules, never the values), or
 * an empty list if they fit. The review screen checks edits with this before saving.
 */
export function checkFields(schema: Record<string, unknown>, fields: unknown): string[] {
  const key = JSON.stringify(schema);
  let validate = fieldValidators.get(key);
  if (!validate) {
    validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    fieldValidators.set(key, validate);
  }
  if (validate(fields)) return [];
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath || "(fields)"} ${e.message ?? "is not valid"}`,
  );
}
