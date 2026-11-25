"use client";
// The review form (task 11), built from the agent's output schema so it works for any
// agent: text fields (with "Not stated" where the schema allows null), lists of objects
// as rows that can be added and removed, and anything else as JSON. The form sends the
// whole set of fields as JSON with the revision it started from; the server checks both.
import { useState } from "react";
import { Button, Checkbox, Field, HiddenField, TextArea } from "./ui/index.ts";

type Json = unknown;
interface PropSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  items?: { type?: string | string[]; properties?: Record<string, PropSchema> };
  properties?: Record<string, PropSchema>;
}

const label = (key: string, s?: PropSchema) =>
  s?.title ??
  key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

const types = (s?: PropSchema) => (Array.isArray(s?.type) ? s.type : s?.type ? [s.type] : []);
const isText = (s?: PropSchema) =>
  types(s).includes("string") && !types(s).some((t) => t === "object" || t === "array");
const isRows = (s?: PropSchema) =>
  types(s).includes("array") && types(s?.items).includes("object") && !!s?.items?.properties;

function TextValue({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: PropSchema;
  value: Json;
  onChange: (v: Json) => void;
  onValidity?: (valid: boolean) => void;
}) {
  const nullable = types(schema).includes("null");
  const missing = value === null || value === undefined;
  return (
    <div className="space-y-1">
      <TextArea
        label={label(name, schema)}
        hint={schema.description}
        value={missing ? "" : String(value)}
        disabled={missing && nullable}
        onChange={(e) => onChange(e.target.value)}
      />
      {nullable ? (
        <Checkbox
          label={`${label(name, schema)}: not stated in the document`}
          checked={missing}
          onChange={(e) => onChange(e.target.checked ? null : "")}
        />
      ) : null}
    </div>
  );
}

function RowsValue({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: PropSchema;
  value: Json;
  onChange: (v: Json) => void;
  onValidity?: (valid: boolean) => void;
}) {
  const rows = Array.isArray(value) ? (value as Record<string, Json>[]) : [];
  const columns = Object.entries(schema.items?.properties ?? {});
  const title = label(name, schema);
  const set = (i: number, key: string, v: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold">{title}</legend>
      {schema.description ? <p className="text-sm text-muted">{schema.description}</p> : null}
      {rows.map((row, i) => (
        <div key={i} className="space-y-3 rounded-md border border-line p-3">
          {columns.map(([key, col]) => (
            <Field
              key={key}
              label={`${label(key, col)} (${title.toLowerCase()} ${i + 1})`}
              value={typeof row[key] === "string" ? (row[key] as string) : ""}
              onChange={(e) => set(i, key, e.target.value)}
            />
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Remove {title.toLowerCase()} {i + 1}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() => onChange([...rows, Object.fromEntries(columns.map(([k]) => [k, ""]))])}
      >
        Add to {title.toLowerCase()}
      </Button>
    </fieldset>
  );
}

function JsonValue({
  name,
  schema,
  value,
  onChange,
  onValidity,
}: {
  name: string;
  schema: PropSchema;
  value: Json;
  onChange: (v: Json) => void;
  onValidity?: (valid: boolean) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | undefined>();
  return (
    <TextArea
      label={label(name, schema)}
      hint="As JSON."
      error={error}
      rows={6}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(JSON.parse(e.target.value));
          setError(undefined);
          onValidity?.(true);
        } catch {
          setError("This is not valid JSON yet.");
          onValidity?.(false);
        }
      }}
    />
  );
}

export function ReviewForm({
  schema,
  fields,
  revision,
  save,
  approve,
}: {
  schema: { properties?: Record<string, PropSchema> };
  fields: Record<string, Json>;
  revision: number;
  save: (formData: FormData) => void | Promise<void>;
  approve: (formData: FormData) => void | Promise<void>;
}) {
  const [values, setValues] = useState(fields);
  // Fields whose JSON does not parse yet: saving waits until they do, so what is sent is
  // always what is shown.
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const validity = (key: string) => (valid: boolean) =>
    setInvalid((old) => {
      const next = new Set(old);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  const properties = Object.entries(schema.properties ?? {});
  const set = (key: string) => (v: Json) => setValues((old) => ({ ...old, [key]: v }));
  return (
    <form action={save} className="space-y-5" data-testid="review-form">
      <HiddenField name="revision" value={revision} />
      <HiddenField name="fields" value={JSON.stringify(values)} />
      {properties.map(([key, prop]) => {
        const Editor = isRows(prop) ? RowsValue : isText(prop) ? TextValue : JsonValue;
        return (
          <Editor
            key={key}
            name={key}
            schema={prop}
            value={values[key]}
            onChange={set(key)}
            onValidity={validity(key)}
          />
        );
      })}
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" disabled={invalid.size > 0}>
          Save changes
        </Button>
        <Button formAction={approve} disabled={invalid.size > 0}>
          Approve
        </Button>
      </div>
    </form>
  );
}
