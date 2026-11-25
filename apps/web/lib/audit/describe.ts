// The audit log in words (task 13), for the activity pages and the CSV export.
import {
  auditEventsAfter,
  type AuditEvent,
  type RefusedSignIns,
  type TenantDatabase,
} from "@agent-core/db";
import { csvLine } from "../export/csv.ts";

/**
 * Who is looking: an operator sees everything; a tenant's admins see that an operator
 * acted, not which of the client's staff it was.
 */
export type AuditView = "operator" | "tenant";

const ROLE: Record<string, string> = { tenant_admin: "Admin", tenant_user: "User" };
const METHOD: Record<string, string> = {
  microsoft: "Microsoft",
  google: "Google",
  "email-link": "an email link",
};

/** Reads a field from an event's detail, which is JSON written by our own code. */
function field(detail: unknown, key: string): unknown {
  return detail && typeof detail === "object"
    ? (detail as Record<string, unknown>)[key]
    : undefined;
}
const text = (detail: unknown, key: string) => {
  const v = field(detail, key);
  return typeof v === "string" ? v : "";
};

export function who(
  e: Pick<AuditEvent, "actorKind" | "actorLabel">,
  view: AuditView = "operator",
): string {
  switch (e.actorKind) {
    case "user":
      return e.actorLabel ?? "A user";
    case "operator":
      return view === "tenant" ? "Operator" : `${e.actorLabel ?? "An operator"} (operator)`;
    case "setup":
      return "Setup command";
    default:
      return "System";
  }
}

export function what(e: Pick<AuditEvent, "action" | "detail">): string {
  const d = e.detail;
  const role = ROLE[text(d, "role")] ?? text(d, "role");
  switch (e.action) {
    case "tenant.created":
      return `Created the tenant ${text(d, "name")} (/t/${text(d, "slug")})`;
    case "user.added":
      return `Added ${text(d, "email")} as ${role}`;
    case "user.restored":
      return `Restored ${text(d, "email")} as ${role}`;
    case "user.role-changed":
      return `Changed ${text(d, "email")} from ${ROLE[text(d, "from")] ?? ""} to ${ROLE[text(d, "to")] ?? ""}`;
    case "user.removed":
      return `Removed ${text(d, "email")}`;
    case "sso.linked":
      return text(d, "provider") === "google"
        ? `Linked work account sign-in to Google Workspace (${text(d, "organisation")})`
        : `Linked work account sign-in to Microsoft (organisation ${text(d, "organisation")})`;
    case "email-links.changed":
      return field(d, "on") === true
        ? "Turned email sign-in links on"
        : "Turned email sign-in links off";
    case "agents.changed": {
      const agents = field(d, "agents");
      return Array.isArray(agents) && agents.length > 0
        ? `Set the agents to ${agents.join(", ")}`
        : "Set no agents (uploads use the default agent)";
    }
    case "sign-in":
      return `Signed in with ${METHOD[text(d, "method")] ?? text(d, "method")}`;
    case "sign-out":
      return "Signed out";
    default:
      return e.action;
  }
}

const CSV_HEADER = [
  "Time (UTC)",
  "Who",
  "Actor kind",
  "Actor ID",
  "Action",
  "Description",
  "Detail",
];
const PAGE = 1000;

/** One CSV line for an event. A tenant's view leaves out which operator it was. */
export function auditCsvLine(e: AuditEvent, view: AuditView): string {
  const hideActor = view === "tenant" && e.actorKind === "operator";
  return csvLine([
    e.occurredAt,
    who(e, view),
    e.actorKind,
    hideActor ? null : e.actorId,
    e.action,
    what(e),
    JSON.stringify(e.detail),
  ]);
}

/** The whole log as CSV, oldest first, read a page at a time. */
export async function* auditCsv(
  db: TenantDatabase,
  tenantId: string,
  view: AuditView,
  pageSize = PAGE,
): AsyncGenerator<string> {
  yield csvLine(CSV_HEADER);
  for (let after = 0; ;) {
    const page = await auditEventsAfter(db, tenantId, after, pageSize);
    if (page.length > 0) yield page.map((e) => auditCsvLine(e, view)).join("");
    if (page.length < pageSize) return;
    after = page[page.length - 1]?.seq ?? after;
  }
}

const METHOD_NAME: Record<string, string> = {
  microsoft: "Microsoft",
  google: "Google",
  "email-link": "Email link",
};

const REASON: Record<string, string> = {
  "unknown-user": "not a user of this portal",
  "not-workspace-account": "not a Google Workspace account in a verified domain",
  "guest-account": "a guest in the organisation, not a member",
  "invalid-token": "the sign-in could not be checked",
  "link-not-valid": "link not valid or expired",
  "email-links-off": "email links are off",
  "organisation-not-linked": "Microsoft organisation not linked",
  "domain-not-linked": "Google domain not linked",
};

/** Refused sign-ins added up per method and reason, most first. */
export function refusalSummary(rows: RefusedSignIns[]): { label: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const label = `${METHOD_NAME[r.method] ?? r.method}: ${REASON[r.reason] ?? r.reason}`;
    totals.set(label, (totals.get(label) ?? 0) + r.count);
  }
  return [...totals].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** Where the refused sign-ins shown start: a week ago. */
export function refusalsSince(now = Date.now()): Date {
  return new Date(now - 7 * 24 * 60 * 60 * 1000);
}
