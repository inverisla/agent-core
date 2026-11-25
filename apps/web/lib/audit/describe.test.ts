import { describe, expect, it } from "vitest";
import { auditCsvLine, refusalSummary, what, who } from "./describe.ts";

const event = (action: string, detail: unknown, extra = {}) => ({
  eventId: "e",
  seq: 1,
  occurredAt: new Date("2026-11-22T10:00:00Z"),
  actorKind: "user" as "user" | "operator",
  actorId: "u1",
  actorLabel: "admin@a.example",
  action,
  detail,
  ...extra,
});

describe("the audit log in words", () => {
  it("describes each kind of event", () => {
    expect(what(event("user.added", { email: "x@a.example", role: "tenant_user" }))).toBe(
      "Added x@a.example as User",
    );
    expect(
      what(
        event("user.role-changed", {
          email: "x@a.example",
          from: "tenant_user",
          to: "tenant_admin",
        }),
      ),
    ).toBe("Changed x@a.example from User to Admin");
    expect(what(event("agents.changed", { agents: [] }))).toBe(
      "Set no agents (uploads use the default agent)",
    );
    expect(what(event("sign-in", { method: "email-link" }))).toBe("Signed in with an email link");
    expect(what(event("email-links.changed", { on: false }))).toBe(
      "Turned email sign-in links off",
    );
    expect(what(event("something.new", {}))).toBe("something.new");
  });

  it("names who did it", () => {
    expect(who({ actorKind: "operator", actorLabel: "op@client.example" })).toBe(
      "op@client.example (operator)",
    );
    expect(who({ actorKind: "setup", actorLabel: null })).toBe("Setup command");
  });

  it("exports a line per event, with hostile text made safe", () => {
    const line = auditCsvLine(
      event("user.added", { email: "=HYPERLINK(1)@a.example", role: "tenant_user" }),
      "operator",
    );
    expect(line).toContain("Added =HYPERLINK(1)@a.example as User");
    expect(line).not.toMatch(/,=/);
    expect(line.endsWith("\r\n")).toBe(true);
  });

  it("shows a tenant that an operator acted, not who", () => {
    const op = event(
      "agents.changed",
      { agents: [] },
      {
        actorKind: "operator" as const,
        actorId: "oid-1",
        actorLabel: "op@client.example",
      },
    );
    expect(who(op, "tenant")).toBe("Operator");
    expect(auditCsvLine(op, "tenant")).not.toMatch(/op@client|oid-1/);
    expect(auditCsvLine(op, "operator")).toMatch(/op@client\.example \(operator\),operator,oid-1/);
  });

  it("adds up refused sign-ins by method and reason", () => {
    const hour = new Date();
    expect(
      refusalSummary([
        { hour, method: "email-link", reason: "link-not-valid", count: 2 },
        { hour, method: "email-link", reason: "link-not-valid", count: 3 },
        { hour, method: "google", reason: "unknown-user", count: 1 },
      ]),
    ).toEqual([
      { label: "Email link: link not valid or expired", count: 5 },
      { label: "Google: not a user of this portal", count: 1 },
    ]);
  });
});
