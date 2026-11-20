/**
 * Step 7 of docs/pipeline-refactor.md: before `items` can be the source of truth
 * for emails, it has to agree with the `emails` rows it mirrors. This compares
 * the two for a request and reports every email whose item is missing or whose
 * state differs. Read-only.
 */
import { emailDecision } from "./items";
import { prisma } from "./prisma";

export interface ParityProblem {
  emailHash: string;
  kind: "missing_item" | "state_differs";
  expected: string;
  actual: string | null;
  reason: string | null;
}

export interface EmailParity {
  checked: number;
  matching: number;
  /** Same state but another rule or decider: expected for mail screening. */
  ruleDiffers: number;
  problems: ParityProblem[];
}

const PAGE = 5_000;

/** Compares the decision of every non-duplicate email of the request with its item. */
export async function checkEmailParity(
  requestId: string,
): Promise<EmailParity> {
  const result: EmailParity = {
    checked: 0,
    matching: 0,
    ruleDiffers: 0,
    problems: [],
  };
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.email.findMany({
      where: {
        is_duplicate: 0,
        processed_file: { case_request_id: requestId },
      },
      orderBy: { email_hash: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { email_hash: cursor } } : {}),
      select: {
        email_hash: true,
        ai_decision: true,
        ai_reason: true,
        rereview_status: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].email_hash;
    const items = new Map(
      (
        await prisma.item.findMany({
          where: { id: { in: rows.map((row) => row.email_hash) } },
          select: { id: true, state: true, decision_rule: true },
        })
      ).map((item) => [item.id, item]),
    );
    for (const row of rows) {
      const expected = emailDecision(row);
      // An email that has not been decided yet need not have an item.
      if (expected.state === "pending" && !items.has(row.email_hash)) continue;
      result.checked += 1;
      const item = items.get(row.email_hash);
      if (!item) {
        result.problems.push({
          emailHash: row.email_hash,
          kind: "missing_item",
          expected: expected.state,
          actual: null,
          reason: row.ai_reason,
        });
      } else if (item.state !== expected.state) {
        result.problems.push({
          emailHash: row.email_hash,
          kind: "state_differs",
          expected: expected.state,
          actual: item.state,
          reason: row.ai_reason,
        });
      } else {
        result.matching += 1;
        if (item.decision_rule !== expected.rule) result.ruleDiffers += 1;
      }
    }
    if (rows.length < PAGE) break;
  }
  return result;
}

/** Groups the problems by the first words of the reason, to see which stage skipped the trail. */
export function problemsByStage(
  problems: ParityProblem[],
): Array<{ stage: string; kind: string; count: number }> {
  const groups = new Map<
    string,
    { stage: string; kind: string; count: number }
  >();
  for (const problem of problems) {
    const stage = (problem.reason ?? "(no reason)").slice(0, 48);
    const key = `${problem.kind}|${stage}`;
    const group = groups.get(key) ?? { stage, kind: problem.kind, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
