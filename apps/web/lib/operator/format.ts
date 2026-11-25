// Small formatting helpers for the operator console's pages.
const dateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/** "23 Nov 2026, 14:02 UTC". */
export function dateTimeUtc(d: Date): string {
  return `${dateTime.format(d)} UTC`;
}

/** "23 Nov 2026". */
export function shortDate(d: Date): string {
  return date.format(d);
}

/** 0.873 as "87%"; null as "–". */
export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`;
}

/** A dollar cost to the cent, or "–" if not priced. */
export function dollars(value: number | null): string {
  return value === null ? "–" : `$${value.toFixed(2)}`;
}
