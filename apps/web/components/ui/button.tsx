import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-60";

export const BUTTON_STYLES: Record<ButtonVariant, string> = {
  // Hover underlines rather than changing colour, so contrast never drops below the theme's.
  primary: `${BASE} bg-primary text-on-primary hover:underline`,
  secondary: `${BASE} border border-line bg-surface text-ink hover:bg-page`,
  danger: `${BASE} border border-danger bg-surface text-danger hover:bg-page`,
};

/** A button. Inside a form it submits unless given another type. */
export function Button({
  variant = "primary",
  className = "",
  type = "submit",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={`${BUTTON_STYLES[variant]} ${className}`} {...props} />;
}

/** A link that looks like a button (for going somewhere, not for doing something). */
export function ButtonLink({
  href,
  variant = "secondary",
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  children: ReactNode;
}) {
  return (
    <a href={href} className={BUTTON_STYLES[variant]}>
      {children}
    </a>
  );
}
