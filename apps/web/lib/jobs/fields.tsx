import { Table, Td, Th, Tr } from "../../components/ui/index.ts";

// An agent's extracted fields, read-only (editing comes with the review screen, task 11).
// Works for any agent's schema: text, lists of objects as tables, nothing as "Not stated".

const label = (key: string) =>
  key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

function Value({ value, label: name }: { value: unknown; label: string }) {
  if (value === null || value === undefined || value === "") return <em>Not stated</em>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <em>None</em>;
    const rows = value.filter(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v),
    );
    if (rows.length === value.length) {
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      return (
        <Table caption={name}>
          <thead>
            <tr>
              {columns.map((c) => (
                <Th key={c}>{label(c)}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <Tr key={i}>
                {columns.map((c) => (
                  <Td key={c}>
                    <Value value={row[c]} label={label(c)} />
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      );
    }
    return (
      <ul className="list-disc space-y-1 pl-5">
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} label={name} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") return <Fields fields={value as Record<string, unknown>} />;
  return <>{String(value)}</>;
}

/** The fields, in `order` first (the agent schema's order), then any others. */
export function Fields({
  fields,
  order = [],
}: {
  fields: Record<string, unknown>;
  order?: string[];
}) {
  const keys = [
    ...order.filter((k) => Object.hasOwn(fields, k)),
    ...Object.keys(fields).filter((k) => !order.includes(k)),
  ];
  return (
    <dl data-testid="job-fields" className="space-y-4">
      {keys
        .map((key) => [key, fields[key]] as const)
        .map(([key, value]) => (
          <div key={key} className="space-y-1">
            <dt className="text-sm font-semibold text-muted">{label(key)}</dt>
            <dd>
              <Value value={value} label={label(key)} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
