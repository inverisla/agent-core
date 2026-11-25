// A tenant's audit log and refused sign-ins (task 13), for the operator console and the
// tenant admin pages.
import type { AuditEvent, RefusedSignIns } from "@agent-core/db";
import { refusalSummary, what, who, type AuditView } from "../lib/audit/describe.ts";
import { ButtonLink, Card, EmptyState, Table, Td, Th, Tr } from "./ui/index.ts";

const when = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function Activity({
  events,
  refusals,
  csvHref,
  view,
  title = "Activity",
}: {
  /** Who is looking: a tenant's admins see "Operator", not which of the client's staff. */
  view: AuditView;
  /** Newest first. */
  events: AuditEvent[];
  /** Refused sign-ins in the last 7 days. */
  refusals: RefusedSignIns[];
  csvHref: string;
  title?: string;
}) {
  const refused = refusalSummary(refusals);
  return (
    <>
      <Card title={title}>
        <p className="text-sm text-muted">
          Changes to users and settings, and sign-ins. This record cannot be changed or deleted from
          here or by the app.
        </p>
        <div>
          <ButtonLink href={csvHref}>Download the whole log (CSV)</ButtonLink>
        </div>
      </Card>
      {events.length === 0 ? (
        <EmptyState title="Nothing recorded yet." />
      ) : (
        <Table caption={`${title}, latest ${events.length}`}>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <Tr key={e.eventId}>
                <Td>{when(e.occurredAt)}</Td>
                <Td>{who(e, view)}</Td>
                <Td>{what(e)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <Card title="Refused sign-ins, last 7 days">
        {refused.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul className="space-y-1" data-testid="refused-sign-ins">
            {refused.map((r) => (
              <li key={r.label}>
                {r.label}: <strong>{r.count}</strong>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted">
          Counted, not listed: the address or link someone tried is not kept.
        </p>
      </Card>
    </>
  );
}
