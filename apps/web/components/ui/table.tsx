import type { ReactNode } from "react";

/**
 * A data table. It scrolls sideways inside its own box on a narrow screen, so the page
 * itself never does (WCAG 1.4.10); the box can take keyboard focus to scroll it.
 */
export function Table({ caption, children }: { caption: ReactNode; children: ReactNode }) {
  return (
    <div
      className="overflow-x-auto rounded-lg border border-line bg-surface"
      // Focusable so keyboard users can scroll it (axe: scrollable-region-focusable).
      tabIndex={0}
      role="region"
      aria-label={typeof caption === "string" ? caption : undefined}
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Th({ children }: { children?: ReactNode }) {
  return (
    <th
      scope="col"
      className="border-b border-line bg-page px-4 py-3 font-semibold whitespace-nowrap"
    >
      {children}
    </th>
  );
}

export function Td({ children }: { children?: ReactNode }) {
  return <td className="border-b border-line px-4 py-3 align-top">{children}</td>;
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="[&:last-child>td]:border-b-0">{children}</tr>;
}
