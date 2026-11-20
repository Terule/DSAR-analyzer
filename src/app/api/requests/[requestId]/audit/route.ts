import { auditCsv } from "@/lib/audit-csv";
import { itemWhere } from "@/lib/item-query";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** The audit trail as CSV, limited to what the decisions panel shows. */
export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  const params = new URL(request.url).searchParams;
  const items = await prisma.item.findMany({
    where:
      params.get("all") === "1"
        ? { case_request_id: requestId }
        : itemWhere(requestId, params),
    orderBy: [{ kind: "asc" }, { origin: "asc" }, { id: "asc" }],
  });
  return new Response(auditCsv(items), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-trail.csv"`,
    },
  });
}
