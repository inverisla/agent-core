// The apps' shared OpenTelemetry setup: names each app (nameService, below), and keeps
// query strings out of traces (task 14). Request URLs can carry personal data and
// secrets: a sign-in link is /t/{slug}/sign-in/verify?email=...&token=... . This span
// processor, given to the OpenTelemetry setup in both apps, cuts the query string from
// every URL attribute as a span starts and again as it ends, and drops url.query.

/** Attributes that hold a URL or a path that may end in a query string. */
const URL_KEYS = ["http.target", "http.url", "url.full", "http.route", "next.route"];
const QUERY_KEYS = ["url.query"];

type Attributes = Record<string, unknown>;

/** The value without its query string or fragment, if it is a string. */
export function withoutQuery(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Cleans a span's attributes in place (they are a plain object on the SDK's spans). */
export function scrubAttributes(attributes: Attributes): void {
  for (const key of URL_KEYS) {
    if (key in attributes) attributes[key] = withoutQuery(attributes[key]);
  }
  for (const key of QUERY_KEYS) Reflect.deleteProperty(attributes, key);
}

interface StartedSpan {
  attributes?: Attributes;
  setAttribute(key: string, value: unknown): unknown;
}

/** An OpenTelemetry SpanProcessor, written against the shape it is given. */
export const queryStringScrubber = {
  onStart(span: StartedSpan): void {
    const attributes = span.attributes ?? {};
    for (const key of URL_KEYS) {
      const value = attributes[key];
      if (typeof value === "string" && /[?#]/.test(value))
        span.setAttribute(key, withoutQuery(value));
    }
  },
  onEnd(span: { attributes: Attributes }): void {
    scrubAttributes(span.attributes);
  },
  forceFlush(): Promise<void> {
    return Promise.resolve();
  },
  shutdown(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * Names the app in Application Insights (its cloud_RoleName), so the web app's requests
 * and the worker's calls can be told apart: OpenTelemetry reads OTEL_SERVICE_NAME when it
 * starts. Called before Azure Monitor starts; a name already set (by a deployment) stays.
 */
export function nameService(
  name: "agentcore-web" | "agentcore-worker",
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env["OTEL_SERVICE_NAME"]) return;
  // Named another way (OTEL_RESOURCE_ATTRIBUTES=service.name=...): OTEL_SERVICE_NAME
  // would win over it, so leave it be.
  if (/(^|,)\s*service\.name=/.test(env["OTEL_RESOURCE_ATTRIBUTES"] ?? "")) return;
  env["OTEL_SERVICE_NAME"] = name;
}
