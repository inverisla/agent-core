// Text extraction runs in a worker thread. Under `node --watch` (how `pnpm dev` runs the
// worker) Node posts its own messages on that thread's channel; extraction must still work.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("text extraction under node --watch", () => {
  it("still reads a PDF", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "extract-watch-"));
    const script = path.join(dir, "run.ts");
    const src = path.join(import.meta.dirname, "index.ts");
    const testing = path.join(import.meta.dirname, "test-files.ts");
    writeFileSync(
      script,
      `import { extractText } from ${JSON.stringify(src)};
import { makeTextPdf } from ${JSON.stringify(testing)};
const pdf = makeTextPdf([["A contract under watch mode."]]);
extractText(pdf, "pdf").then(
  (r) => console.log("RESULT ok " + r.text.trim()),
  (e) => console.log("RESULT failed " + e.message),
);
`,
    );
    const child = spawn(process.execPath, ["--watch", script], { cwd: import.meta.dirname });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`no result: ${out}`)), 20_000);
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = /RESULT [^\n]*/.exec(out);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
      });
      expect(line).toBe("RESULT ok A contract under watch mode.");
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
