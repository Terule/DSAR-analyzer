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
import { auditCsv, cleanAuditLabel } from "./audit-csv";
import { prisma } from "./prisma";

export type ItemState = "pending" | "kept" | "discarded" | "review";

export interface ItemDecision {
  state: ItemState;
  rule: string | null;
  reason: string | null;
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
  /**
   * Identity of the item: the delivered path (`Documents/<name>`) when the file
   * was delivered, so the AI verdict on that file lands on the same item, or the
   * path inside the Files folder when it never was.
   */
  relPath: string;
  /** What a person recognises (the path inside the Files folder); defaults to `relPath`. */
  label?: string;
  state: ItemState;
  rule: string;
  reason: string | null;
  decidedBy: string;
  /** Items inside this one, such as the messages of a chat export. */
  children?: ChildItemDecision[];
}

/** A part of a file that was judged on its own (a chat message). */
export interface ChildItemDecision {
  /** Stable key inside the parent, for example the message key. */
  key: string;
  /** A neutral name: a position, never an author or text. */
  label: string;
  state: ItemState;
  rule: string;
  reason: string | null;
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
      const unchanged =
        previous &&
        previous.state === decision.state &&
        previous.decision_rule === decision.rule &&
        previous.reason === decision.reason &&
        previous.decided_by === decision.decidedBy;
      if (unchanged) {
        if (decision.children?.length) {
          await recordChildItems(
            fileId,
            row?.case_request_id ?? null,
            id,
            decision.children,
          );
        }
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
            label: decision.label ?? decision.relPath,
            state: decision.state,
            decision_rule: decision.rule,
            reason: decision.reason,
            decided_by: decision.decidedBy,
          },
          update: {
            ...(decision.label ? { label: decision.label } : {}),
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
      if (decision.children?.length) {
        await recordChildItems(
          fileId,
          row?.case_request_id ?? null,
          id,
          decision.children,
        );
      }
    }
  } catch (error) {
    console.warn("[Items] Could not record the audit trail:", error);
  }
}

/** Records the parts of one item (chat messages) in bulk; idempotent. Never throws. */
async function recordChildItems(
  fileId: string,
  caseRequestId: string | null,
  parentId: string,
  children: ChildItemDecision[],
): Promise<void> {
  try {
    const prepared = children.map((child) => ({
      id: crypto
        .createHash("sha256")
        .update(`child:${parentId}:${child.key}`)
        .digest("hex"),
      child,
    }));
    const existing = new Set(
      (
        await prisma.item.findMany({
          where: { id: { in: prepared.map((entry) => entry.id) } },
          select: { id: true },
        })
      ).map((item) => item.id),
    );
    const fresh = prepared.filter((entry) => !existing.has(entry.id));
    if (fresh.length === 0) return;
    await prisma.$transaction([
      prisma.item.createMany({
        skipDuplicates: true,
        data: fresh.map(({ id, child }) => ({
          id,
          case_request_id: caseRequestId,
          file_id: fileId,
          parent_id: parentId,
          kind: "chat_message",
          origin: "files_folder",
          label: child.label,
          state: child.state,
          decision_rule: child.rule,
          reason: child.reason,
          decided_by: "rule",
        })),
      }),
      prisma.itemEvent.createMany({
        data: fresh.map(({ id, child }) => ({
          item_id: id,
          state: child.state,
          decision_rule: child.rule,
          reason: child.reason,
          decided_by: "rule",
        })),
      }),
    ]);
  } catch (error) {
    console.warn("[Items] Could not record chat messages:", error);
  }
}

/** Convenience for the Files engine: its decisions carry absolute paths. */
export function fileDecisionToItem(
  inputDir: string,
  decision: {
    filePath: string;
    state: "discarded" | "kept";
    rule: string;
    reason: string;
    deliveredRel?: string;
    messages?: ChildItemDecision[];
  },
): FileItemDecision {
  const inputRel = path.relative(inputDir, decision.filePath);
  return {
    relPath: decision.deliveredRel ?? inputRel,
    label: inputRel,
    state: decision.state,
    rule: decision.rule,
    reason: decision.reason,
    decidedBy: "rule",
    ...(decision.messages?.length ? { children: decision.messages } : {}),
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
 * email. A zip entry carries its path inside the archive in `filename`. Written
 * in bulk (one read, one insert, updates only for what changed) because a case
 * can have tens of thousands of attachments. Never throws.
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
    const prepared = decisions.map((decision) => ({
      id: crypto
        .createHash("sha256")
        .update(`attachment:${parentHash}:${decision.filename}`)
        .digest("hex"),
      decision,
    }));
    const existing = new Map(
      (
        await prisma.item.findMany({
          where: { id: { in: prepared.map((entry) => entry.id) } },
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
    const fresh: typeof prepared = [];
    for (const entry of prepared) {
      const previous = existing.get(entry.id);
      const d = entry.decision;
      if (!previous) {
        fresh.push(entry);
        continue;
      }
      if (
        previous.state === d.state &&
        previous.decision_rule === d.rule &&
        previous.reason === d.reason &&
        previous.decided_by === d.decidedBy
      ) {
        continue;
      }
      await prisma.$transaction([
        prisma.item.update({
          where: { id: entry.id },
          data: {
            state: d.state,
            decision_rule: d.rule,
            reason: d.reason,
            decided_by: d.decidedBy,
          },
        }),
        prisma.itemEvent.create({
          data: {
            item_id: entry.id,
            state: d.state,
            decision_rule: d.rule,
            reason: d.reason,
            decided_by: d.decidedBy,
          },
        }),
      ]);
    }
    if (fresh.length > 0) {
      await prisma.$transaction([
        prisma.item.createMany({
          skipDuplicates: true,
          data: fresh.map(({ id, decision: d }) => ({
            id,
            case_request_id: row?.case_request_id ?? null,
            file_id: fileId,
            parent_id: parentHash,
            kind: "file",
            origin: "attachment",
            label: d.filename,
            state: d.state,
            decision_rule: d.rule,
            reason: d.reason,
            decided_by: d.decidedBy,
          })),
        }),
        prisma.itemEvent.createMany({
          data: fresh.map(({ id, decision: d }) => ({
            item_id: id,
            state: d.state,
            decision_rule: d.rule,
            reason: d.reason,
            decided_by: d.decidedBy,
          })),
        }),
      ]);
    }
  } catch (error) {
    console.warn("[Items] Could not record the audit trail:", error);
  }
}

/**
 * The audit trail of a request as the one CSV (`audit-csv.ts`). `states` limits
 * what is listed; the decisions panel exports what is on screen through the same
 * function. Returns null when the request has no items.
 */
export async function auditTrailCsv(
  caseRequestId: string,
  states?: ItemState[],
): Promise<string | null> {
  const items = await prisma.item.findMany({
    where: {
      case_request_id: caseRequestId,
      ...(states ? { state: { in: states } } : {}),
    },
    orderBy: [{ kind: "asc" }, { origin: "asc" }, { id: "asc" }],
  });
  return items.length === 0 ? null : auditCsv(items);
}

/**
 * Writes `Discarded/audit-trail.csv` for a request that discarded something:
 * every item that was discarded or sent to a person (kept items stay in the
 * database only, so the file reads as a list of exceptions), in the same format
 * as the export of the decisions panel. Never throws: the trail is a record,
 * not a stage.
 */
export async function exportAuditTrail(
  caseRequestId: string | null | undefined,
  requestOutputDir: string,
): Promise<string | null> {
  if (!caseRequestId) return null;
  try {
    const items = await prisma.item.findMany({
      where: {
        case_request_id: caseRequestId,
        state: { in: ["discarded", "review"] },
      },
      orderBy: [{ kind: "asc" }, { origin: "asc" }, { id: "asc" }],
    });
    // The Discarded folder exists only for requests that discarded something.
    if (!items.some((item) => item.state === "discarded")) return null;
    const directory = path.join(requestOutputDir, "Discarded");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "audit-trail.csv");
    fs.writeFileSync(file, auditCsv(items));
    return file;
  } catch (error) {
    console.warn("[Items] Could not export the audit trail:", error);
    return null;
  }
}

/**
 * Duplicates have no `emails` row of their own, so they are recorded as items
 * whose parent is the email they duplicate. They can be hundreds of thousands,
 * so they are buffered and written in bulk. Never throws.
 */
export function createDuplicateRecorder(
  fileId: string,
  caseRequestId: string | null | undefined,
  chunkSize = 500,
) {
  const perHash = new Map<string, number>();
  let buffer: Array<{ id: string; parent: string; label: string }> = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      const existing = new Set(
        (
          await prisma.item.findMany({
            where: { id: { in: batch.map((entry) => entry.id) } },
            select: { id: true },
          })
        ).map((item) => item.id),
      );
      const fresh = batch.filter((entry) => !existing.has(entry.id));
      if (fresh.length === 0) return;
      const reason = "Duplicate of an email already kept in this request.";
      await prisma.$transaction([
        prisma.item.createMany({
          skipDuplicates: true,
          data: fresh.map((entry) => ({
            id: entry.id,
            case_request_id: caseRequestId ?? null,
            file_id: fileId,
            parent_id: entry.parent,
            kind: "email",
            origin: "pst",
            label: entry.label || null,
            state: "discarded",
            decision_rule: "dup",
            reason,
            decided_by: "rule",
          })),
        }),
        prisma.itemEvent.createMany({
          data: fresh.map((entry) => ({
            item_id: entry.id,
            state: "discarded",
            decision_rule: "dup",
            reason,
            decided_by: "rule",
          })),
        }),
      ]);
    } catch (error) {
      console.warn("[Items] Could not record duplicates:", error);
    }
  };

  return {
    async add(emailHash: string, subject?: string): Promise<void> {
      const n = (perHash.get(emailHash) ?? 0) + 1;
      perHash.set(emailHash, n);
      buffer.push({
        id: crypto
          .createHash("sha256")
          .update(`duplicate:${fileId}:${emailHash}:${n}`)
          .digest("hex"),
        parent: emailHash,
        label: cleanAuditLabel(subject),
      });
      if (buffer.length >= chunkSize) await flush();
    },
    flush,
  };
}
