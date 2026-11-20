import type { Prisma } from "@prisma/client";
import { type ItemTab, rulesForStep, tabFilter } from "./request-insights";

/** Where the filters of the decisions panel become a database filter. */
export function itemWhere(
  requestId: string,
  params: URLSearchParams,
): Prisma.ItemWhereInput {
  const rawTab = params.get("tab") ?? "emails";
  // "all" is the human review list: every kind of item together.
  const base = rawTab === "all" ? null : tabFilter(rawTab as ItemTab);
  const where: Prisma.ItemWhereInput = {
    case_request_id: requestId,
    ...(base
      ? {
          origin: base.origin as string,
          ...(base.kind ? { kind: base.kind } : {}),
        }
      : {}),
  };
  const step = params.get("step");
  if (step) {
    const rules = rulesForStep(step);
    if (rules) where.decision_rule = { in: rules };
  }
  const rule = params.get("rule");
  if (rule) where.decision_rule = rule;
  const state = params.get("state");
  if (state) where.state = state;
  const query = params.get("q")?.trim();
  if (query) where.label = { contains: query, mode: "insensitive" };
  return where;
}
