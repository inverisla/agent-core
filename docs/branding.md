# Branding and the look of the app

Every page is built from the shared components in `apps/web/components/ui/`, styled with
Tailwind CSS. A client changes the look in two places:

1. **`apps/web/theme.ts`**: the product name and the colours. The colours become CSS
   variables (`--brand-*`) that every component uses, so a change here reaches every
   page.
2. **`apps/web/public/`**: the logo file named in `theme.ts` (an SVG or PNG, shown about
   28 px high beside the product name). The logo keeps its own colours: the default one is
   blue, so replace it when you change the colours.

Only the theme's colours exist in the CSS: Tailwind's own palette is switched off, so a
page cannot use `bg-blue-600` or similar and escape the theme.

The colours must stay readable. `pnpm test` checks each pair the components use against
WCAG 2.2 AA (4.5:1 for text, 3:1 for borders and the focus outline) and fails with the
pair's name if one does not. Colours are six-digit hex only (`#1d4ed8`).

## Rules for pages

- Build pages from the components (`AppShell` through the area shells in
  `apps/web/components/shells.tsx`, `PageHeader`, `Card`, `Button`, `Field`, `Table`,
  `StatusBadge`, `Alert`, `EmptyState`). A lint rule refuses raw `<button>`, `<input>`,
  `<select>`, `<textarea>` and `<table>` outside `components/ui/`.
- Errors use `<Alert tone="danger">` (read out at once), confirmations `tone="success"`.
- Status is always shown as a word, never by colour alone.
- Fonts are the device's own: nothing is fetched from a font service.

## Checks

The Playwright tests run axe (WCAG 2.2 A and AA) on every page in the role matrix and the
public and error pages, check each shows the theme's product name and colours, and load
each at phone width (390 px) to make sure nothing scrolls sideways
(`apps/web/e2e/look.spec.ts`).
