// The theme's colours as CSS variables (hex values only, checked in themeCss), served as a
// stylesheet rather than an inline <style>, so the Content Security Policy can allow
// styles from this app only (proxy.ts).
import { themeCss } from "../../lib/theme/theme.ts";
import { theme } from "../../theme.ts";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(themeCss(theme), {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      // Its address never changes, so a CDN in front must not keep it for long.
      "Cache-Control": "public, max-age=300",
    },
  });
}
