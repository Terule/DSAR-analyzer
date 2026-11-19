/**
 * Audit trail in shadow mode (docs/pipeline-refactor.md, step 0).
 *
 * `items` holds one row per email (later also files, attachments and chat
 * messages) with the rule that last decided it; `item_events` keeps every change.
 * Nothing in the pipeline reads these tables yet: they only record what the
 * existing stages already decided, so a failure here must never change a decision
 * or stop a stage.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

/** Maps the text the Files engine logs for a discard to the rule that decided it. */
export function fileDiscardRule(text: string): string {
  if (/Duplicate/i.test(text)) return "dup";
  if (/Password-protected|encrypted/i.test(text)) return "password";
  if (/excluded keyword/i.test(text)) return "keyword";
  if (/subject header pattern|authored by subject/i.test(text)) {
    return "chat_legacy";
  }
  if (/not mentioned|Missing subject name/i.test(text)) return "subject_absent";
  if (/0-byte|empty output/i.test(text)) return "empty_output";
  if (/signature image/i.test(text)) return "signature_image";
  if (/unreadable image/i.test(text)) return "unreadable_image";
  if (/unsupported format/i.test(text)) return "unsupported_type";
  return "files_filter";
}

/** Stable id of a file in a Files folder: the processed-files row and the path inside it. */
export function fileItemId(fileId: string, relPath: string): string {
  return crypto
    .createHash("sha256")
    .update(`file:${fileId}:${relPath}`)
    .digest("hex");
}

export interface FileItemDecision {
  /** Path relative to the Files folder. */
  relPath: string;
  state: ItemState;
  rule: string;
  reason: string | null;
  decidedBy: string;
}

/**
 * Records decisions about files of a Files folder (a `processed_files` row).
 * Writes an event only when something changed. Never throws.
 */
export async function recordFileItems(
  fileId: string,
  decisions: FileItemDecision[],
): Promise<void> {
  if (decisions.length === 0) return;
  try {
    const row = await prisma.processedFile.findUnique({
      where: { id: fileId },
      select: { case_request_id: true },
    });
    for (const decision of decisions) {
      const id = fileItemId(fileId, decision.relPath);
      const previous = await prisma.item.findUnique({
        where: { id },
        select: {
          state: true,
          decision_rule: true,
          reason: true,
          decided_by: true,
        },
      });
      if (
        previous &&
        previous.state === decision.state &&
        previous.decision_rule === decision.rule &&
        previous.reason === decision.reason &&
        previous.decided_by === decision.decidedBy
      ) {
        continue;
      }
      await prisma.$transaction([
        prisma.item.upsert({
          where: { id },
          create: {
            id,
            case_request_id: row?.case_request_id ?? null,
            file_id: fileId,
            kind: "file",
            origin: "files_folder",
            label: decision.relPath,
            state: decision.state,
            decision_rule: decision.rule,
            reason: decision.reason,
            decided_by: decision.decidedBy,
          },
          update: {
            state: decision.state,
            decision_rule: decision.rule,
            reason: decision.reason,
            decided_by: decision.decidedBy,
          },
        }),
        prisma.itemEvent.create({
          data: {
            item_id: id,
            state: decision.state,
            decision_rule: decision.rule,
            reason: decision.reason,
            decided_by: decision.decidedBy,
          },
        }),
      ]);
    }
  } catch (error) {
    console.warn("[Items] Could not record the audit trail:", error);
  }
}

/** Convenience for the Files engine: its decisions carry absolute paths. */
export function fileDecisionToItem(
  inputDir: string,
  decision: {
    filePath: string;
    state: "discarded";
    rule: string;
    reason: string;
  },
): FileItemDecision {
  return {
    relPath: path.relative(inputDir, decision.filePath),
    state: decision.state,
    rule: decision.rule,
    reason: decision.reason,
    decidedBy: "rule",
  };
}

export interface AttachmentDecision {
  filename: string;
  state: ItemState;
  rule: string;
  reason: string | null;
  decidedBy: string;
}

/**
 * Records what happened to an email's attachments, as items whose parent is the
 * email. A zip entry carries its path inside the archive in `filename`. Never throws.
 */
export async function recordAttachmentItems(
  fileId: string,
  parentHash: string,
  decisions: AttachmentDecision[],
): Promise<void> {
  if (decisions.length === 0) return;
  try {
    const row = await prisma.processedFile.findUnique({
      where: { id: fileId },
      select: { case_request_id: true },
    });
    for (const decision of decisions) {
      const id = crypto
        .createHash("sha256")
        .update(`attachment:${parentHash}:${decision.filename}`)
        .digest("hex");
      const data = {
        state: decision.state,
        decision_rule: decision.rule,
        reason: decision.reason,
        decided_by: decision.decidedBy,
      };
      const previous = await prisma.item.findUnique({
        where: { id },
        select: {
          state: true,
          decision_rule: true,
          reason: true,
          decided_by: true,
        },
      });
      if (
        previous &&
        previous.state === data.state &&
        previous.decision_rule === data.decision_rule &&
        previous.reason === data.reason &&
        previous.decided_by === data.decided_by
      ) {
        continue;
      }
      await prisma.$transaction([
        prisma.item.upsert({
          where: { id },
          create: {
            id,
            case_request_id: row?.case_request_id ?? null,
            file_id: fileId,
            parent_id: parentHash,
            kind: "file",
            origin: "attachment",
            label: decision.filename,
            ...data,
          },
          update: data,
        }),
        prisma.itemEvent.create({
          data: { item_id: id, ...data, state: data.state },
        }),
      ]);
    }
  } catch (error) {
    console.warn("[Items] Could not record the audit trail:", error);
  }
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Writes `Discarded/audit-trail.csv` for a request that discarded something:
 * every item that was discarded, kept or sent to a person, with the rule and who decided. Never throws:
 * the trail is a record, not a stage.
 */
export async function exportAuditTrail(
  caseRequestId: string | null | undefined,
  requestOutputDir: string,
): Promise<string | null> {
  if (!caseRequestId) return null;
  try {
    const items = await prisma.item.findMany({
      where: { case_request_id: caseRequestId, state: { not: "pending" } },
      orderBy: [{ kind: "asc" }, { origin: "asc" }, { id: "asc" }],
    });
    // The Discarded folder exists only for requests that discarded something.
    if (!items.some((item) => item.state === "discarded")) return null;
    const directory = path.join(requestOutputDir, "Discarded");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "audit-trail.csv");
    const lines = [
      "item,kind,origin,parent,state,rule,reason,decided_by,decided_at",
      ...items.map((item) =>
        [
          item.label ?? item.id.slice(0, 16),
          item.kind,
          item.origin,
          item.parent_id ? item.parent_id.slice(0, 16) : "",
          item.state,
          item.decision_rule ?? "",
          item.reason ?? "",
          item.decided_by ?? "",
          item.updated_at.toISOString(),
        ]
          .map((cell) => csvCell(String(cell)))
          .join(","),
      ),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  } catch (error) {
    console.warn("[Items] Could not export the audit trail:", error);
    return null;
  }
}
