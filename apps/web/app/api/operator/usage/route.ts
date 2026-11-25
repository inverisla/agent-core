import { apiError, checkOperator } from "../../../../lib/auth/guards.ts";
import { csvResponse } from "../../../../lib/export/csv.ts";
import { currentMonth, usageCsv, usageForMonth } from "../../../../lib/operator/usage.ts";

export const dynamic = "force-dynamic";

/** Every tenant's usage for ?month=YYYY-MM (this month if none), as CSV. Operators only. */
export async function GET(req: Request): Promise<Response> {
  const access = await checkOperator();
  if (!access.ok) return apiError(access.status);
  const month = new URL(req.url).searchParams.get("month") ?? currentMonth();
  const rows = await usageForMonth(month);
  if (!rows)
    return Response.json(
      { error: "month", message: "Give the month as YYYY-MM." },
      { status: 400 },
    );
  // The month is checked as YYYY-MM above, so the filename is safe.
  return csvResponse(`usage-${month}.csv`, usageCsv(month, rows));
}
