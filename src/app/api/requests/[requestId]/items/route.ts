import { NextResponse } from "next/server";
import { itemWhere } from "@/lib/item-query";
import { prisma } from "@/lib/prisma";
import { analysisLabel, type ItemTab, tabFilter } from "@/lib/request-insights";

export const dynamic = "force-dynamic";

const PAGE = 100;

export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  const params = new URL(request.url).searchParams;
  const where = itemWhere(requestId, params);
  const { state: _state, ...withoutState } = where;
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const tabs: ItemTab[] = ["emails", "attachments", "files"];
  const [items, byState, ...tabTotals] = await Promise.all([
    prisma.item.findMany({
      where,
      orderBy: { updated_at: "desc" },
      skip: offset,
      take: PAGE,
      select: {
        id: true,
        label: true,
        kind: true,
        origin: true,
        state: true,
        decision_rule: true,
        reason: true,
        decided_by: true,
        updated_at: true,
      },
    }),
    prisma.item.groupBy({
      by: ["state"],
      where: withoutState,
      _count: { _all: true },
    }),
    ...tabs.map((tab) => {
      // Tab totals follow the step that is open, so "Attachments 3" counts what
      // that step removed among attachments.
      const tabParams = new URLSearchParams(params);
      tabParams.set("tab", tab);
      tabParams.delete("state");
      tabParams.delete("q");
      return prisma.item.count({ where: itemWhere(requestId, tabParams) });
    }),
  ]);
  const hashes = items
    .filter((item) => item.kind === "email" && item.state === "discarded")
    .map((item) => item.id);
  // A provisional discard waiting for the 2nd analysis reads as "Reanalysing".
  const waiting = new Set(
    (
      await prisma.email.findMany({
        where: { email_hash: { in: hashes }, rereview_status: "pending" },
        select: { email_hash: true },
      })
    ).map((row) => row.email_hash),
  );
  const counts: Record<string, number> = {};
  for (const group of byState) counts[group.state] = group._count._all;
  return NextResponse.json({
    items: items.map((item) => {
      const reanalysing = waiting.has(item.id);
      return {
        id: item.id,
        label: item.label || item.id.slice(0, 16),
        kind: item.kind,
        state: reanalysing ? "reanalysing" : item.state,
        rule: item.decision_rule,
        reason: item.reason,
        time: item.updated_at.toISOString(),
        analysis: analysisLabel(
          item.decided_by,
          item.decision_rule,
          item.state,
          reanalysing,
        ),
      };
    }),
    counts: { ...counts, reanalysing: waiting.size },
    tabs: {
      emails: tabTotals[0],
      attachments: tabTotals[1],
      files: tabTotals[2],
    },
    hasMore:
      offset + items.length < Object.values(counts).reduce((a, b) => a + b, 0),
  });
}
