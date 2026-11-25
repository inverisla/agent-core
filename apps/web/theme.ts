// The client's brand: change this file (and the logo in public/) to rebrand every page.
// Colours must keep text readable: a unit test checks each pair below meets WCAG 2.2 AA
// contrast (4.5:1 for text, 3:1 for borders and focus), so a failing choice fails CI.
import type { Theme } from "./lib/theme/theme.ts";

export const theme: Theme = {
  productName: "Agent core",
  // Shown beside the product name, so it is decorative (no alt text needed).
  logo: { src: "/logo.svg", width: 28, height: 28 },
  colors: {
    primary: "#1d4ed8", // buttons, links, focus outline
    onPrimary: "#ffffff", // text on primary
    background: "#f8fafc", // the page
    surface: "#ffffff", // cards, tables, the header
    text: "#0f172a",
    muted: "#475569", // secondary text
    border: "#64748b", // inputs, table lines
    success: "#15803d",
    warning: "#b45309",
    danger: "#b91c1c",
  },
};
