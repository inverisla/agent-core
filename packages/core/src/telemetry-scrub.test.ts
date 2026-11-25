import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  nameService,
  queryStringScrubber,
  scrubAttributes,
  withoutQuery,
} from "./telemetry-scrub.ts";

const LINK = "/t/acme/sign-in/verify?email=someone%40example.com&token=abcdefabcdef";

describe("keeping query strings out of traces", () => {
  it("cuts the query string and fragment from a URL", () => {
    expect(withoutQuery(LINK)).toBe("/t/acme/sign-in/verify");
    expect(withoutQuery("https://app.example/x#frag")).toBe("https://app.example/x");
    expect(withoutQuery("/plain")).toBe("/plain");
    expect(withoutQuery(42)).toBe(42);
  });

  it("cleans every URL attribute and drops url.query when a span ends", () => {
    const attributes: Record<string, unknown> = {
      "http.target": LINK,
      "http.url": `https://app.example${LINK}`,
      "url.full": `https://app.example${LINK}`,
      "url.query": "email=someone%40example.com&token=abcdefabcdef",
      "http.method": "GET",
    };
    queryStringScrubber.onEnd({ attributes });
    expect(JSON.stringify(attributes)).not.toMatch(/someone|token|abcdef/);
    expect(attributes).toEqual({
      "http.target": "/t/acme/sign-in/verify",
      "http.url": "https://app.example/t/acme/sign-in/verify",
      "url.full": "https://app.example/t/acme/sign-in/verify",
      "http.method": "GET",
    });
  });

  it("cleans URL attributes a span starts with", () => {
    const set: Record<string, unknown> = {};
    queryStringScrubber.onStart({
      attributes: { "http.target": LINK },
      setAttribute: (k: string, v: unknown) => (set[k] = v),
    });
    expect(set).toEqual({ "http.target": "/t/acme/sign-in/verify" });
    const a: Record<string, unknown> = { "next.route": "/t/[slug]" };
    scrubAttributes(a);
    expect(a).toEqual({ "next.route": "/t/[slug]" });
  });
});

describe("the apps' names in Application Insights", () => {
  it("sets OTEL_SERVICE_NAME, keeping one a deployment set", () => {
    const env: NodeJS.ProcessEnv = {};
    nameService("agentcore-worker", env);
    expect(env["OTEL_SERVICE_NAME"]).toBe("agentcore-worker");
    const set: NodeJS.ProcessEnv = { OTEL_SERVICE_NAME: "chosen" };
    nameService("agentcore-web", set);
    expect(set["OTEL_SERVICE_NAME"]).toBe("chosen");
    const attributes: NodeJS.ProcessEnv = { OTEL_RESOURCE_ATTRIBUTES: "team=x,service.name=y" };
    nameService("agentcore-web", attributes);
    expect(attributes["OTEL_SERVICE_NAME"]).toBeUndefined();
  });

  it("is called by each app before Azure Monitor starts", () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    for (const [file, name, start] of [
      ["apps/web/instrumentation.ts", "agentcore-web", "startAzureMonitor({"],
      ["apps/worker/src/telemetry.ts", "agentcore-worker", "useAzureMonitor({"],
    ] as const) {
      const source = readFileSync(path.join(root, file), "utf8");
      const named = source.indexOf(`nameService("${name}")`);
      expect(named, file).toBeGreaterThan(-1);
      expect(named, file).toBeLessThan(source.indexOf(start));
    }
  });
});
