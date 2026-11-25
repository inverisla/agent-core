// Tenant slugs name a tenant's portal: /t/{slug}. Operators choose them when creating a
// tenant; slugFromName gives the default. They are fixed once created.

/** Words a slug may not be, because they are (or may become) routes. */
export const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "operator",
  "operators",
  "sign-in",
  "sign-out",
  "static",
  "t",
  "www",
]);

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Returns why a slug is not allowed, or null if it is fine. */
export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug)) {
    return "Use 3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit.";
  }
  if (slug.includes("--")) return "Use single hyphens only.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved.`;
  return null;
}

/** A default slug from a tenant name: "Northwind Traders" becomes "northwind-traders". */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}
