// Which sign-in is in progress: the operator console, or one tenant's portal. Set in a
// cookie when sign-in starts, because the Entra callback URL is shared by everyone.
// The cookie is not trusted for access: the sign-in rules check that the person really
// belongs to the tenant it names.
import { slugProblem } from "@agent-core/db";

export const SCOPE_COOKIE = "agentcore.sign-in-scope";

export type SignInScope = { kind: "operator" } | { kind: "tenant"; slug: string };

export function scopeToCookie(scope: SignInScope): string {
  return scope.kind === "operator" ? "operator" : `tenant:${scope.slug}`;
}

export function scopeFromCookie(value: string | undefined): SignInScope | null {
  if (value === "operator") return { kind: "operator" };
  if (value?.startsWith("tenant:")) {
    const slug = value.slice("tenant:".length);
    if (slugProblem(slug) === null) return { kind: "tenant", slug };
  }
  return null;
}
