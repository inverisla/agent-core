// Operational events (task 14): one JSON line each on standard output, which Container
// Apps sends to Log Analytics, where the alert rules look for them; and a count of each,
// for Application Insights when telemetry is set up (see the apps' start-up).
//
// Only IDs and codes go in an event: any text that could be an email address, a name or
// document content is replaced, so a careless call cannot leak personal data into logs.
import { metrics } from "@opentelemetry/api";

/** Every event name, so alert rules and dashboards can rely on them. */
export const EVENT_NAMES = [
  "job.failed",
  "job.succeeded",
  "worker.started",
  "worker.heartbeat",
  "audit.copied",
  "audit.copy-failed",
  "app.error",
  "email.failed",
  "agent.tested",
  "agent.test-failed",
  "sign-in.refused",
  "job.restarted",
  "job.stuck",
  "job.decision-undelivered",
  "upload.failed",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export type EventLevel = "info" | "warn" | "error";
export type EventValue = string | number | boolean | null;

/**
 * IDs, reason codes, agent names and versions, and route patterns such as
 * /t/[slug]/documents: letters, digits and . _ : - / [ ] only. No @, spaces or quotes,
 * so no email address or sentence gets through.
 */
const SAFE = /^[A-Za-z0-9._:/[\]-]{0,200}$/;
const SAFE_KEY = /^[A-Za-z0-9_]{1,40}$/;

/**
 * The value as it may be written. Checked at run time, not only by the types (review
 * S17): an object, an array or anything else that is not a string, number, boolean or
 * null is replaced, since it could carry anything.
 */
export function safeValue(value: unknown): EventValue {
  if (typeof value === "string") return SAFE.test(value) ? value : "[redacted]";
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  return "[redacted]";
}

const meter = metrics.getMeter("agent-core");
const counters = new Map<EventName, ReturnType<typeof meter.createCounter>>();

/** Writes one event line and counts it. Returns the line, for tests. */
export function logEvent(
  event: EventName,
  fields: Record<string, EventValue> = {},
  level: EventLevel = "info",
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): string {
  const safe: Record<string, EventValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SAFE_KEY.test(key)) safe[key] = safeValue(value);
  }
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...safe });
  write(line);
  let counter = counters.get(event);
  if (!counter) {
    counter = meter.createCounter(`agentcore.${event}`);
    counters.set(event, counter);
  }
  // Counted by the fields that are codes, never by IDs (one series per job would be useless).
  const attributes: Record<string, string> = {};
  for (const key of ["agent", "reason", "code", "step"]) {
    const value = safe[key];
    if (typeof value === "string") attributes[key] = value;
  }
  counter.add(1, attributes);
  return line;
}
