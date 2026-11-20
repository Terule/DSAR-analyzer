import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { analysisLabel } from "@/lib/request-insights";

export const dynamic = "force-dynamic";

/** One item with every change of its state, for the item panel. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ itemId: string }> },
) {
  const { itemId } = await context.params;
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { events: { orderBy: { created_at: "asc" } } },
  });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  const email =
    item.kind === "email"
      ? await prisma.email.findUnique({
          where: { email_hash: item.id },
          select: {
            sent_date: true,
            is_duplicate: true,
          },
        })
      : null;
  const parent = item.parent_id
    ? await prisma.item.findUnique({
        where: { id: item.parent_id },
        select: { id: true, label: true },
      })
    : null;
  return NextResponse.json({
    item: {
      id: item.id,
      label: item.label || item.id.slice(0, 16),
      kind: item.kind,
      origin: item.origin,
      state: item.rereview_status === "pending" ? "reanalysing" : item.state,
      rule: item.decision_rule,
      reason: item.reason,
      decidedBy: item.decided_by,
      analysis: analysisLabel(
        item.decided_by,
        item.decision_rule,
        item.state,
        item.rereview_status === "pending",
      ),
      confidenceKeep: item.ai_p_keep ?? null,
      sentDate: email?.sent_date ?? null,
      parent: parent
        ? { id: parent.id, label: parent.label || parent.id.slice(0, 16) }
        : null,
      events: item.events.map((event) => ({
        id: event.id,
        state: event.state,
        rule: event.decision_rule,
        reason: event.reason,
        decidedBy: event.decided_by,
        time: event.created_at.toISOString(),
      })),
    },
  });
}
