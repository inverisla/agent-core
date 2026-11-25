// Every page is built from the shared components: the lint rule refuses raw form
// controls and tables in the web app outside components/ui.
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..", "..", "..", "..");
const lint = async (file: string, code: string) => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, {
    filePath: path.join(root, file),
  });
  return (result?.messages ?? []).map((m) => m.message);
};

describe("the shared-components rule", () => {
  it("refuses a raw button, input, select, textarea or table in a page", async () => {
    for (const tag of ["button", "input", "select", "textarea", "table"]) {
      const messages = await lint(
        "apps/web/app/example/page.tsx",
        `export default function P() { return <${tag} />; }\n`,
      );
      expect(messages.join("\n"), tag).toMatch(/shared components/);
    }
  }, 30_000);

  it("allows them inside the components themselves", async () => {
    const messages = await lint(
      "apps/web/components/ui/example.tsx",
      'export function X() { return <button type="button" />; }\n',
    );
    expect(messages.join("\n")).not.toMatch(/shared components/);
  }, 30_000);
});
