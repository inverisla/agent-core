// What the operator console keeps of an agent version (task 16). Its own module, with no
// file-system paths, so the web app can use it.
import type { LoadedAgent } from "@agent-core/core/agents";

const TEXT_FILES = /\.(md|json|txt)$/i;

/** What the operator console keeps of a version: agent.json and the text of its files. */
export function agentSnapshot(agent: LoadedAgent): {
  definition: unknown;
  files: { path: string; text: string | null; bytes: number }[];
} {
  return {
    definition: agent.definition,
    files: agent.files.map((file) => {
      const bytes = agent.contents.get(file) ?? Buffer.alloc(0);
      return {
        path: file,
        text: TEXT_FILES.test(file) ? bytes.toString("utf8") : null,
        bytes: bytes.length,
      };
    }),
  };
}
