/**
 * Step 7 of docs/pipeline-refactor.md: `items` is the record of email
 * decisions, so it has to cover every email the pipeline read. This reports,
 * for a request, the emails that have no item (a decision or a queue entry that
 * never reached the trail) and the email items that have no email row. Read-only.
 */
import { prisma } from "./prisma";

export interface EmailCoverage {
  /** Non-duplicate email rows of the request. */
  emails: number;
  /** Email items of the request, duplicates excluded. */
  items: number;
  /** Email hashes with no item (the first few). */
  missingItems: string[];
  missingCount: number;
  /** Email items whose email row is gone. */
  orphanItems: number;
  /** Items still waiting for the AI (pending). */
  pending: number;
}

const PAGE = 5_000;

export async function checkEmailCoverage(
  requestId: string,
): Promise<EmailCoverage> {
  const result: EmailCoverage = {
    emails: 0,
    items: 0,
    missingItems: [],
    missingCount: 0,
    orphanItems: 0,
    pending: 0,
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
      select: { email_hash: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].email_hash;
    const have = new Set(
      (
        await prisma.item.findMany({
          where: { id: { in: rows.map((row) => row.email_hash) } },
          select: { id: true },
        })
      ).map((item) => item.id),
    );
    for (const row of rows) {
      result.emails += 1;
      if (!have.has(row.email_hash)) {
        result.missingCount += 1;
        if (result.missingItems.length < 20) {
          result.missingItems.push(row.email_hash);
        }
      }
    }
    if (rows.length < PAGE) break;
  }
  const itemWhere = {
    case_request_id: requestId,
    kind: "email",
    OR: [{ decision_rule: null }, { decision_rule: { not: "dup" } }],
  };
  result.items = await prisma.item.count({ where: itemWhere });
  result.pending = await prisma.item.count({
    where: { ...itemWhere, state: "pending" },
  });
  result.orphanItems = Math.max(
    0,
    result.items - (result.emails - result.missingCount),
  );
  return result;
}
