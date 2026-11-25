import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const INPUT =
  "block w-full min-h-11 rounded-md border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-muted aria-[invalid=true]:border-danger";

/**
 * A labelled input with an optional hint and error, tied to it for screen readers
 * (WCAG 1.3.1, 3.3.1). Pass the input's own attributes as for <input>.
 */
export function Field({
  label,
  hint,
  error,
  id: givenId,
  className = "",
  "aria-describedby": givenDescribedBy,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const generated = useId();
  const id = givenId ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [givenDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;
  const file = input.type === "file";
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <input
        {...input}
        id={id}
        aria-describedby={describedBy}
        aria-invalid={error ? true : input["aria-invalid"]}
        className={`${
          file
            ? `${INPUT} file:mr-3 file:rounded file:border-0 file:bg-page file:px-3 file:py-1 file:font-semibold file:text-ink`
            : INPUT
        } ${className}`}
      />
    </div>
  );
}

/** A form's fields and buttons, spaced as a column. */
export function FormStack({ children }: { children: ReactNode }) {
  return <div className="flex max-w-md flex-col gap-4">{children}</div>;
}

/** A labelled multi-line text box, wired like Field. */
export function TextArea({
  label,
  hint,
  error,
  id: givenId,
  className = "",
  "aria-describedby": givenDescribedBy,
  ...area
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const generated = useId();
  const id = givenId ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [givenDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <textarea
        rows={3}
        {...area}
        id={id}
        aria-describedby={describedBy}
        aria-invalid={error ? true : area["aria-invalid"]}
        className={`${INPUT} min-h-20 ${className}`}
      />
    </div>
  );
}

/** A checkbox with its label beside it; the whole row is the target (WCAG 2.5.8). */
export function Checkbox({
  label,
  className = "",
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label
      className={`inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm ${className}`}
    >
      <input type="checkbox" className="size-5 accent-primary" {...input} />
      {label}
    </label>
  );
}

/** A value the form sends without showing it. */
export function HiddenField({ name, value }: { name: string; value: string | number }) {
  return <input type="hidden" name={name} value={value} />;
}

/** A labelled drop-down, wired like Field. */
export function Select({
  label,
  hint,
  options,
  id: givenId,
  className = "",
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode;
  hint?: ReactNode;
  options: { value: string; label: string }[];
}) {
  const generated = useId();
  const id = givenId ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <select {...select} id={id} aria-describedby={hintId} className={`${INPUT} ${className}`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
