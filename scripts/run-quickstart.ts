// Task 15's done-when, first half: runs the README's quick start exactly as written (the
// commands between the quickstart markers), in order, on a fresh machine, and fails if it
// does not work or takes longer than 10 minutes. The last command (`pnpm dev`) is started
// in the background, and the clock stops when the demo portal answers; the app is left
// running for the demo walkthrough (apps/web/e2e-demo). Used by CI (.github/workflows/ci.yml).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

const LIMIT_MS = 10 * 60 * 1000;
const ROOT = path.join(import.meta.dirname, "..");
const PORTAL = "http://localhost:3000/t/demo-ltd/sign-in";

/** The commands in the README between the quickstart markers. */
export function quickstartCommands(readme: string): string[] {
  const block = /<!-- quickstart:start -->([\s\S]*?)<!-- quickstart:end -->/.exec(readme)?.[1];
  if (!block) throw new Error("The README has no quickstart markers.");
  const fenced = /```bash\n([\s\S]*?)```/.exec(block)?.[1];
  if (!fenced) throw new Error("The README's quick start has no bash block.");
  return fenced
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function waitFor(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${url} did not answer in time.`);
}

if (import.meta.main) {
  const commands = quickstartCommands(readFileSync(path.join(ROOT, "README.md"), "utf8"));
  const last = commands.at(-1);
  if (last !== "pnpm dev")
    throw new Error(`The quick start should end with pnpm dev, not ${last}.`);
  const started = Date.now();
  const deadline = started + LIMIT_MS;
  const times: string[] = [];
  for (const command of commands.slice(0, -1)) {
    const t = Date.now();
    console.log(`\n$ ${command}`);
    const run = spawnSync("bash", ["-c", command], {
      cwd: ROOT,
      stdio: "inherit",
      timeout: Math.max(deadline - Date.now(), 1),
    });
    if (run.error) throw new Error(`"${command}" did not finish within the 10 minutes.`);
    times.push(`${command}: ${Math.round((Date.now() - t) / 1000)} s`);
    if (run.status !== 0) throw new Error(`"${command}" failed (exit ${run.status}).`);
  }
  console.log(`\n$ ${last}   (in the background; output in quickstart-dev.log)`);
  const log = openSync(path.join(ROOT, "quickstart-dev.log"), "w");
  spawn("bash", ["-c", last], { cwd: ROOT, stdio: ["ignore", log, log], detached: true }).unref();
  const t = Date.now();
  await waitFor(PORTAL, deadline);
  times.push(`${last}, until the demo portal answers: ${Math.round((Date.now() - t) / 1000)} s`);
  const total = Math.round((Date.now() - started) / 1000);
  const summary = [
    `### README quick start: ${total} s (limit ${LIMIT_MS / 1000} s)`,
    ...times.map((l) => `- ${l}`),
  ].join("\n");
  console.log(`\n${summary}`);
  const out = process.env["GITHUB_STEP_SUMMARY"];
  if (out) appendFileSync(out, `${summary}\n`);
  if (Date.now() > deadline) throw new Error(`The quick start took ${total} s, over 10 minutes.`);
}
