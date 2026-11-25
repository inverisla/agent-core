import { apiError, checkTenant } from "../../../../../../lib/auth/guards.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const result = await checkTenant(slug, { admin: true });
  if (!result.ok) return apiError(result.status);
  return Response.json({ kind: "tenant", userId: result.value.userId, role: result.value.role });
}
