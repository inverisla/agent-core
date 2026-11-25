// An agent as it was at a git ref (task 12): the files of its folder in that commit are
// written to a temporary folder, straight from git's objects (not `git archive`, which
// .gitattributes can change), and loaded there, so the comparison runs exactly the files
// that had that version.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgent, type LoadedAgent } from "@agent-core/core/agents";

const REF = /^[\w./~^@{}-]+$/;

/**
 * The agent in `agentDir` (relative to the repository root) at `ref`, or null if the
 * agent did not exist there. Throws if `ref` is not a commit. The caller calls
 * `cleanup()` when done.
 */
export async function loadAgentAtRef(
  repoRoot: string,
  ref: string,
  agentDir: string,
): Promise<{ agent: LoadedAgent; commit: string; cleanup: () => void } | null> {
  if (!REF.test(ref) || ref.startsWith("-")) throw new Error(`Not a git ref: ${ref}`);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  let commit: string;
  try {
    commit = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])
      .toString()
      .trim();
  } catch {
    throw new Error(`Not a commit in this repository: ${ref}`);
  }
  const listing = git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", agentDir])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", file = ""] = line.split("\t");
      const [mode = "", type = "", sha = ""] = meta.split(" ");
      return { mode, type, sha, file };
    });
  if (!listing.some((e) => e.file === path.posix.join(agentDir, "agent.json"))) return null;
  const dir = mkdtempSync(path.join(tmpdir(), "agent-at-ref-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    for (const entry of listing) {
      if (entry.type !== "blob") continue; // submodules have no files here
      const target = path.join(dir, entry.file);
      mkdirSync(path.dirname(target), { recursive: true });
      const bytes = git(["cat-file", "blob", entry.sha]);
      // A link stays a link, so the loader refuses it as it would in the working tree.
      if (entry.mode === "120000") symlinkSync(bytes.toString(), target);
      else writeFileSync(target, bytes);
    }
    return { agent: await loadAgent(path.join(dir, agentDir)), commit, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
