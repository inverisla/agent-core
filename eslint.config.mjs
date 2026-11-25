// @ts-check
import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

// Model calls go through the gateway only (review S12). A deny-list, so it catches the
// usual ways round it, not every one: model SDKs, other HTTP clients, model API hosts in
// strings, and fetch() outside the gateway (apps/web/lib/theme/gateway-lint.test.ts tries
// each). Not caught, for example: a require() made with createRequire and kept in a
// variable, or an address built from parts at run time.
const MODEL_HOSTS = [
  "openai\\.azure\\.com",
  "cognitiveservices\\.azure\\.com",
  "services\\.ai\\.azure\\.com",
  "bedrock-runtime",
  "api\\.openai\\.com",
  "api\\.anthropic\\.com",
  "generativelanguage\\.googleapis\\.com",
  "aiplatform\\.googleapis\\.com",
  "api\\.mistral\\.ai",
  "api\\.cohere\\.(ai|com)",
  "api\\.groq\\.com",
  "api\\.together\\.xyz",
  "openrouter\\.ai",
  "huggingface\\.co",
].join("|");
/** Packages that call models, or make HTTP calls that could. */
const BLOCKED_PACKAGES = [
  "openai",
  "@azure/openai",
  "@azure-rest/ai-inference",
  "@anthropic-ai/*",
  "@aws-sdk/client-bedrock*",
  "@google/genai",
  "@google/generative-ai",
  "@google-cloud/vertexai",
  "@mistralai/*",
  "cohere-ai",
  "groq-sdk",
  "ai",
  "@ai-sdk/*",
  "langchain",
  "@langchain/*",
  "ollama",
  "@huggingface/*",
  "undici",
  "node-fetch",
  "axios",
  "got",
  "ky",
  "node:http",
  "node:https",
  "http",
  "https",
  "node:http2",
  "http2",
  // Raw sockets (not child processes: tests and setup start the app with them), and the
  // HTTP clients under the Azure SDKs this repo uses
  // (review of C2–D3); and the AWS SDK's, for when a client adds it.
  "node:net",
  "net",
  "node:tls",
  "tls",
  "node:dgram",
  "dgram",
  "@azure/core-rest-pipeline",
  "@azure/core-client",
  "@azure/core-http-compat",
  "@azure-rest/core-client",
  "@typespec/ts-http-runtime",
  "@smithy/node-http-handler",
  "@smithy/fetch-http-handler",
];
// As one regex: a package by its exact name, or a path inside it ("openai/resources"),
// never a local folder that happens to share a name ("./ai"). "/" is escaped: it goes
// inside /…/ in a selector.
const MODEL_SDKS = `^(${BLOCKED_PACKAGES.map((p) =>
  p.replace(/[.]/g, "\\.").replace(/\//g, "\\/").replace(/\*/g, "[^/]*"),
).join("|")})(\\/.*)?$`;
const GATEWAY_ONLY = "Call models through @agent-core/core/models (the model gateway).";

const GATEWAY_SYNTAX = [
  ...["Literal[value=", "TemplateElement[value.raw="].map((node) => ({
    selector: `${node}/${MODEL_HOSTS}/]`,
    message: GATEWAY_ONLY,
  })),
  // import("openai") and require("openai"), which no-restricted-imports misses.
  { selector: `ImportExpression[source.value=/${MODEL_SDKS}/]`, message: GATEWAY_ONLY },
  {
    selector: `CallExpression[callee.name="require"][arguments.0.value=/${MODEL_SDKS}/]`,
    message: GATEWAY_ONLY,
  },
  // createRequire(import.meta.url)("openai").
  {
    selector: `CallExpression[callee.type="CallExpression"][arguments.0.value=/${MODEL_SDKS}/]`,
    message: GATEWAY_ONLY,
  },
];
// fetch(), globalThis.fetch() and the like: only the gateway's adapters make HTTP calls.
// Tests and the quick-start check may (they call the app, not a model).
// The globals that reach the network: fetch, WebSocket, EventSource.
const NETWORK_GLOBALS = "fetch|WebSocket|EventSource";
const NO_FETCH = [
  // Used at all, not only called: `const f = fetch`, `urls.map(fetch)`, `new W()` after
  // `const W = WebSocket`. A property, key or member of that name (`res.fetch`,
  // `{ fetch: … }`, a type's member, `typeof fetch`) is not the global. A parameter named
  // fetch is refused on purpose: pass a gateway, not a fetch.
  {
    selector: `Identifier[name=/^(${NETWORK_GLOBALS})$/]:not(MemberExpression > Identifier.property):not(Property > Identifier.key):not(TSPropertySignature > Identifier.key):not(TSMethodSignature > Identifier.key):not(MethodDefinition > Identifier.key):not(PropertyDefinition > Identifier.key):not(TSTypeQuery > Identifier)`,
    message: GATEWAY_ONLY,
  },
  // globalThis.fetch, globalThis["fetch"] and the like.
  {
    selector: `MemberExpression[object.name=/^(globalThis|window|self|global)$/][property.name=/^(${NETWORK_GLOBALS})$/]`,
    message: GATEWAY_ONLY,
  },
  {
    selector: `MemberExpression[object.name=/^(globalThis|window|self|global)$/][property.value=/^(${NETWORK_GLOBALS})$/]`,
    message: GATEWAY_ONLY,
  },
];
const MAY_FETCH = [
  "**/*.test.ts",
  "apps/web/e2e/**",
  "apps/web/e2e-demo/**",
  "scripts/run-quickstart.ts",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  ...nextVitals.map((config) => ({
    ...config,
    files: ["apps/web/**/*.{ts,tsx}"],
    settings: { ...config.settings, next: { rootDir: "apps/web" } },
  })),
  // Model calls go through the gateway only (CLAUDE.md): no model SDKs, and no model API
  // addresses, outside packages/core/src/models.
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    ignores: ["packages/core/src/models/**", "eslint.config.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            // By exact package name (a "group" pattern would also match any folder of the
            // same name, such as ./ai or ./http).
            { regex: MODEL_SDKS.replaceAll("\\/", "/"), message: GATEWAY_ONLY },
            {
              group: [
                // The adapters themselves, reached around the gateway by path.
                "**/core/src/models/*",
                "!**/core/src/models/index.ts",
              ],
              message: GATEWAY_ONLY,
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...GATEWAY_SYNTAX, ...NO_FETCH],
    },
  },
  {
    files: MAY_FETCH,
    ignores: ["packages/core/src/models/**"],
    rules: { "no-restricted-syntax": ["error", ...GATEWAY_SYNTAX] },
  },
  // Pages are built from the shared components (task 10b): no raw form controls or tables
  // outside apps/web/components/ui. Repeats the gateway rules, since a later
  // no-restricted-syntax replaces an earlier one rather than adding to it.
  {
    files: ["apps/web/**/*.tsx"],
    ignores: ["apps/web/components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...GATEWAY_SYNTAX,
        ...NO_FETCH,
        {
          selector: "JSXOpeningElement[name.name=/^(button|input|select|textarea|table)$/]",
          message:
            "Use the shared components in apps/web/components/ui (Button, Field, Table…) so every page looks and behaves the same.",
        },
      ],
    },
  },
  prettier,
);
