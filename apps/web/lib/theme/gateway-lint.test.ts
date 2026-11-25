// The gateway-only rule (review S12, T10): model calls go through @agent-core/core/models.
// A deny-list, so this tries the usual ways round it, and checks the gateway itself and
// tests are left alone.
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..", "..", "..", "..");
const eslint = new ESLint({ cwd: root });
const refused = async (file: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return (result?.messages ?? []).some((m) => /model gateway/.test(m.message));
};

describe("the gateway-only rule", () => {
  it("refuses model SDKs, HTTP clients, model hosts and fetch outside the gateway", async () => {
    for (const code of [
      'import OpenAI from "openai";\n',
      'import { x } from "@anthropic-ai/sdk";\n',
      'import { generateText } from "ai";\n',
      'import { GoogleGenAI } from "@google/genai";\n',
      'import { request } from "undici";\n',
      'import https from "node:https";\n',
      'export const m = await import("@mistralai/mistralai");\n',
      'export const m = require("axios");\n',
      // Paths inside a package, and a require made with createRequire.
      'export const m = await import("openai/resources");\n',
      'export const m = require("undici/index.js");\n',
      'import { x } from "@ai-sdk/openai/internal";\n',
      'import { createRequire } from "node:module";\nexport const m = createRequire(import.meta.url)("openai");\n',
      // Model hosts, as code to try: the rule's own targets, so not written out here.
      `export const u = "https://my.${"openai"}.azure.com/openai/v1";\n`,
      `export const u = \`https://\${'x'}.api.${"groq"}.com/v1\`;\n`,
      'await fetch("https://example.com");\n',
      'await globalThis.fetch("https://example.com");\n',
      // Review of C2–D3: fetch by reference, sockets, and HTTP clients in the tree.
      'const f = fetch;\nawait f("https://example.com");\n',
      'await Promise.all(["https://example.com"].map(fetch));\n',
      'export const ws = new WebSocket("wss://example.com");\n',
      'import { connect } from "node:net";\n',
      'import { connect } from "node:tls";\n',
      'import { createDefaultHttpClient } from "@azure/core-rest-pipeline";\n',
      'import { NodeHttpHandler } from "@smithy/node-http-handler";\n',
      'import { getClient } from "@azure-rest/core-client";\n',
      'import { ServiceClient } from "@azure/core-client";\n',
      'import { createDefaultHttpClient } from "@typespec/ts-http-runtime";\n',
      'const W = WebSocket;\nexport const ws = new W("wss://example.com");\n',
      'export const ws = new globalThis.WebSocket("wss://example.com");\n',
      'export const es = new EventSource("https://example.com");\n',
      'await globalThis["fetch"]("https://example.com");\n',
      'import { x } from "../../packages/core/src/models/azure-openai.ts";\n',
    ]) {
      for (const file of ["apps/worker/src/example.ts", "apps/web/app/example/page.tsx"]) {
        expect(await refused(file, code), `${file}: ${code}`).toBe(true);
      }
    }
  }, 60_000);

  it("leaves the gateway itself, tests and the gateway's entry point alone", async () => {
    expect(
      await refused("packages/core/src/models/example.ts", 'await fetch("https://x");\n'),
    ).toBe(false);
    expect(
      await refused("apps/worker/src/example.test.ts", 'await fetch("http://localhost");\n'),
    ).toBe(false);
    expect(
      await refused("apps/worker/src/example.ts", 'import { x } from "@agent-core/core/models";\n'),
    ).toBe(false);
  }, 60_000);

  it("covers .mts and .cts files too", async () => {
    for (const file of ["apps/worker/src/example.mts", "packages/core/src/example.cts"]) {
      expect(await refused(file, 'import OpenAI from "openai";\n'), file).toBe(true);
    }
  }, 60_000);

  it("leaves a property or key named fetch alone", async () => {
    for (const code of [
      "export const x = (r: { fetch: () => void }) => r.fetch();\n",
      "export const y = { fetch: 1 };\n",
      "export type F = typeof fetch;\n",
    ]) {
      expect(await refused("apps/worker/src/example.ts", code), code).toBe(false);
    }
  }, 60_000);

  it("leaves a local folder alone when it shares a name with a blocked package", async () => {
    for (const code of [
      'import { x } from "./ai";\n',
      'import { x } from "../lib/ai/index.ts";\n',
      'import { x } from "./http/client.ts";\n',
      'import { x } from "@agent-core/http";\n',
      'import { x } from "./got/index.ts";\n',
    ]) {
      expect(await refused("apps/worker/src/example.ts", code), code).toBe(false);
    }
  }, 60_000);
});
