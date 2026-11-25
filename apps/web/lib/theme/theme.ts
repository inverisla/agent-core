// The theme's shape, its CSS variables, and the contrast checks it must pass.

export interface Theme {
  productName: string;
  /** A file in public/, shown at this size beside the product name. */
  logo: { src: string; width: number; height: number };
  colors: {
    primary: string;
    onPrimary: string;
    background: string;
    surface: string;
    text: string;
    muted: string;
    border: string;
    success: string;
    warning: string;
    danger: string;
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The theme's colours as CSS variables on :root, which globals.css maps to Tailwind's
 * colours. Only six-digit hex colours are accepted, so nothing else can reach the CSS.
 */
export function themeCss(theme: Theme): string {
  const vars = Object.entries(theme.colors).map(([name, value]) => {
    if (!HEX.test(value)) throw new Error(`Theme colour ${name} must be #rrggbb, not ${value}`);
    return `--brand-${kebab(name)}:${value.toLowerCase()};`;
  });
  return `:root{${vars.join("")}}`;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The WCAG contrast ratio of two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The pairs the components use, with the ratio WCAG 2.2 AA needs for each. */
export function contrastPairs(
  c: Theme["colors"],
): { name: string; ratio: number; needs: number }[] {
  const text = 4.5;
  const ui = 3;
  return [
    ["text on background", c.text, c.background, text],
    ["text on surface", c.text, c.surface, text],
    ["muted text on background", c.muted, c.background, text],
    ["muted text on surface", c.muted, c.surface, text],
    ["button text on primary", c.onPrimary, c.primary, text],
    ["links on background", c.primary, c.background, text],
    ["links on surface", c.primary, c.surface, text],
    ["success on surface", c.success, c.surface, text],
    ["warning on surface", c.warning, c.surface, text],
    ["danger on surface", c.danger, c.surface, text],
    ["danger on background", c.danger, c.background, text],
    ["input borders on surface", c.border, c.surface, ui],
    ["focus outline on background", c.primary, c.background, ui],
    ["focus outline on surface", c.primary, c.surface, ui],
  ].map(([name, fg, bg, needs]) => ({
    name: name as string,
    ratio: contrast(fg as string, bg as string),
    needs: needs as number,
  }));
}
