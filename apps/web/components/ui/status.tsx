import type { ReactNode } from "react";

export type Tone = "info" | "success" | "warning" | "danger";

const TONE: Record<Tone, string> = {
  info: "border-line text-ink",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

const STATUS_TONE: Record<string, Tone> = {
  uploaded: "info",
  queued: "info",
  running: "warning",
  succeeded: "success",
  failed: "danger",
  awaiting_review: "warning",
  approved: "success",
};

/** A job's status as a badge: always the word itself, never colour alone (WCAG 1.4.1). */
export function StatusBadge({ status, testId }: { status: string; testId?: string }) {
  const tone = STATUS_TONE[status] ?? "info";
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center rounded-full border bg-surface px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

/**
 * A message box. Errors use role="alert" (read out at once); confirmations use
 * role="status"; plain information has no role.
 */
export function Alert({
  tone = "info",
  testId,
  children,
}: {
  tone?: Tone;
  testId?: string;
  children: ReactNode;
}) {
  const role = tone === "danger" ? "alert" : tone === "success" ? "status" : undefined;
  return (
    <div
      role={role}
      data-testid={testId}
      className={`rounded-md border-l-4 bg-surface px-4 py-3 text-sm ${TONE[tone]}`}
    >
      {children}
    </div>
  );
}
