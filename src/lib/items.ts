/**
 * Audit trail in shadow mode (docs/pipeline-refactor.md, step 0).
 *
 * `items` holds one row per email (later also files, attachments and chat
 * messages) with the rule that last decided it; `item_events` keeps every change.
 * Nothing in the pipeline reads these tables yet: they only record what the
 * existing stages already decided, so a failure here must never change a decision
 * or stop a stage.
 */
import { prisma } from "./prisma";

export type ItemState = "pending" | "kept" | "discarded" | "review";

export interface ItemDecision {
  state: ItemState;
  rule: string | null;
  reason: string | null;
}

interface EmailDecisionRow {
  ai_decision: string | null;
  ai_reason: string | null;
  rereview_status: string | null;
}

/** Maps the reason text the stages already write to the rule that produced it. */
function ruleForEmailReason(reason: string): string | null {
  if (reason.startsWith("Pre-filter: Subject or body contains")) {
    return "keyword";
  }
  if (reason.startsWith("Pre-filter: Data subject not mentioned")) {
    return "subject_absent";
  }
  if (reason.startsWith("System Discard: Draft")) return "draft";
  if (reason.startsWith("Client case: deduplication only"))
    return "client_case";
  if (reason.startsWith("Self-forward")) return "self_forward";
  return null;
}

/** Pure: what an `emails` row means as an item decision. */
export function emailDecision(row: EmailDecisionRow): ItemDecision {
  const reason = row.ai_reason ?? "";
  const rule = ruleForEmailReason(reason);
  switch (row.ai_decision) {
    case "keep":
      return {
        state: "kept",
        rule: rule ?? "ai_email",
        reason: reason || null,
      };
    case "discard":
      return {
        state: "discarded",
        rule: rule ?? "ai_email",
        reason: reason || null,
      };
    case "warning":
      return {
        state: "review",
        rule: rule ?? "self_forward",
        reason: reason || null,
      };
    default:
      return { state: "pending", rule: null, reason: null };
  }
}

export interface SyncEmailItemsOptions {
  /** Who produced the decision being written: "haiku-4.5" or "haiku-5.5". Rules need none. */
  decidedBy?: string;
  /** Names the rule when the reason text does not (for example the mail screening). */
  rule?: string;
}

/**
 * Records the current decision of these emails (by `email_hash`). Writes an
 * event only when the state, rule, reason or decider changed. Never throws.
 */
export async function syncEmailItems(
  emailHashes: string[],
  options: SyncEmailItemsOptions = {},
): Promise<void> {
  const hashes = [...new Set(emailHashes.filter(Boolean))];
  if (hashes.length === 0) return;
  try {
    const rows = await prisma.email.findMany({
      where: { email_hash: { in: hashes } },
      select: {
        email_hash: true,
        file_id: true,
        parent_email_hash: true,
        is_attachment: true,
        ai_decision: true,
        ai_reason: true,
        rereview_status: true,
        processed_file: { select: { case_request_id: true } },
      },
    });
    const existing = new Map(
      (
        await prisma.item.findMany({
          where: { id: { in: hashes } },
          select: {
            id: true,
            state: true,
            decision_rule: true,
            reason: true,
            decided_by: true,
          },
        })
      ).map((item) => [item.id, item]),
    );

    for (const row of rows) {
      const computed = emailDecision(row);
      const decision =
        options.rule && computed.state !== "pending"
          ? { ...computed, rule: options.rule }
          : computed;
      const previous = existing.get(row.email_hash) ?? null;
      let by: string | null = null;
      if (decision.state !== "pending") {
        by =
          options.decidedBy ??
          (decision.rule === "ai_email"
            ? (previous?.decided_by ?? null)
            : "rule");
      }
      const unchanged =
        previous &&
        previous.state === decision.state &&
        previous.decision_rule === decision.rule &&
        previous.reason === decision.reason &&
        previous.decided_by === by;
      if (unchanged) continue;

      await prisma.$transaction([
        prisma.item.upsert({
          where: { id: row.email_hash },
          create: {
            id: row.email_hash,
            case_request_id: row.processed_file?.case_request_id ?? null,
            file_id: row.file_id,
            parent_id: row.parent_email_hash,
            kind: "email",
            origin: row.is_attachment ? "attachment" : "pst",
            state: decision.state,
            decision_rule: decision.rule,
            reason: decision.reason,
            decided_by: by,
          },
          update: {
            state: decision.state,
            decision_rule: decision.rule,
            reason: decision.reason,
            decided_by: by,
          },
        }),
        prisma.itemEvent.create({
          data: {
            item_id: row.email_hash,
            state: decision.state,
            decision_rule: decision.rule,
            reason: decision.reason,
            decided_by: by,
          },
        }),
      ]);
    }
  } catch (error) {
    console.warn("[Items] Could not record the audit trail:", error);
  }
}
