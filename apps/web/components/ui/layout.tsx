import type { ReactNode } from "react";
import { theme } from "../../theme.ts";
import { Button } from "./button.tsx";

export interface NavItem {
  href: string;
  label: string;
  current?: boolean;
  /** The current page is inside this item's section rather than the item itself. */
  inside?: boolean;
}

/**
 * Every page's frame: a skip link, the header with the brand, the area's navigation and
 * sign-out, and the main content. Pages without a signed-in user leave nav and user out.
 */
export function AppShell({
  homeHref = "/",
  area,
  nav = [],
  user,
  signOut,
  children,
}: {
  homeHref?: string;
  /** Shown after the product name, for example "Operator console". */
  area?: string;
  nav?: NavItem[];
  user?: string;
  signOut?: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <a
            href={homeHref}
            className="flex min-h-11 items-center gap-2 font-semibold text-ink no-underline"
            data-testid="brand"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a small static logo */}
            <img src={theme.logo.src} width={theme.logo.width} height={theme.logo.height} alt="" />
            <span>{theme.productName}</span>
            {area ? <span className="font-normal text-muted">{area}</span> : null}
          </a>
          {nav.length > 0 ? (
            <nav aria-label="Main" className="flex flex-wrap gap-1">
              {nav.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={item.current ? (item.inside ? "true" : "page") : undefined}
                  className="flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-ink no-underline hover:bg-page aria-[current]:bg-page aria-[current]:text-primary"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
          {user || signOut ? (
            <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
              {user ? <span className="text-sm text-muted">{user}</span> : null}
              {signOut ? (
                <form action={signOut}>
                  <Button variant="secondary">Sign out</Button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-5xl space-y-6 px-4 py-8 focus:outline-none"
      >
        {children}
      </main>
    </>
  );
}

/** The page's heading, an optional line under it, and actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** A titled box of content. */
export function Card({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-lg border border-line bg-surface p-5">
      {title ? <h2 className="text-lg font-semibold">{title}</h2> : null}
      {children}
    </section>
  );
}

/** What a list shows when it has nothing in it. */
export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
    </div>
  );
}
