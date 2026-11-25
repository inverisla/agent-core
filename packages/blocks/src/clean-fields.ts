// Field values made safe to store and to put in a Word report: every character XML cannot
// hold is removed from strings and keys (NUL, which Postgres refuses too; other control
// characters such as the form feed between a PDF's pages; U+FFFE and U+FFFF; and lone
// surrogates). Tab, line feed and carriage return stay. Used where the model's fields are
// saved (the worker), where a reviewer's edits are saved (the web app), and before a
// report is written (word-report.ts).

// Allowed: tab, LF, CR, U+0020–U+D7FF, U+E000–U+FFFD, and surrogate pairs (U+10000 on).
const NOT_XML =
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(text: string): string {
  return text.replace(NOT_XML, "");
}

/** The value with every character XML cannot hold removed from its strings and keys. */
export function cleanFields<T>(value: T): T {
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") return cleanText(v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [cleanText(k), clean(x)]));
    return v;
  };
  return clean(value) as T;
}
