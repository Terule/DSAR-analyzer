import { NextResponse } from "next/server";
import { aiUsageByRequest } from "@/lib/ai-cost";
import { prisma } from "@/lib/prisma";
import { buildFunnel } from "@/lib/request-insights";

export const dynamic = "force-dynamic";

/** Per request: share removed by the fixed filters and the estimated AI cost. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await context.params;
  const requests = await prisma.caseRequest.findMany({
    where: { case_id: caseId },
    select: { id: true, name: true },
    orderBy: { created_at: "asc" },
  });
  if (requests.length === 0) {
    const exists = await prisma.managedCase.count({ where: { id: caseId } });
    if (!exists)
      return NextResponse.json({ error: "Case not found." }, { status: 404 });
  }
  const ids = requests.map((request) => request.id);
  const [groups, usage] = await Promise.all([
    prisma.item.groupBy({
      by: ["case_request_id", "state", "decision_rule"],
      where: {
        case_request_id: { in: ids },
        origin: { in: ["pst", "files_folder"] },
        kind: { not: "chat_message" },
      },
      _count: { _all: true },
    }),
    aiUsageByRequest(ids),
  ]);
  const rows = requests.map((request) => {
    const funnel = buildFunnel(
      groups
        .filter((group) => group.case_request_id === request.id)
        .map((group) => ({
          state: group.state,
          rule: group.decision_rule,
          count: group._count._all,
        })),
    );
    const cost = usage.get(request.id);
    return {
      requestId: request.id,
      name: request.name,
      removedPercent: funnel.total > 0 ? funnel.removedPercent : null,
      costUsd: cost?.costUsd ?? 0,
      inputTokens: cost?.inputTokens ?? 0,
    };
  });
  return NextResponse.json({
    requests: rows,
    costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
  });
}
