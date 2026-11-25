import { apiError, checkOperator } from "../../../../lib/auth/guards.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await checkOperator();
  if (!result.ok) return apiError(result.status);
  return Response.json({ kind: "operator", oid: result.value.oid });
}
