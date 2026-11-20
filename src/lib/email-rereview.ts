import fs from "node:fs";
import path from "node:path";
import {
  buildEmailAuditSystemPrompt,
  emailAiTestOverride,
  RESPONSE_FORMAT,
  stripPayloadSignatures,
} from "./ai";
import { completeEmailAudit, emailRereviewPending } from "./batch-worker";
import { CONVERSE_MODEL } from "./bedrock/config";
import { getCasePstFileIds } from "./case-utils";
import { applyConfidentiality } from "./email-audit";
import { decideEmail } from "./email-decisions";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";
import {
  runSecondReview,
  type SecondReviewAdapter,
  type SecondReviewOptions,
} from "./second-review";

export interface EmailRereviewOptions extends SecondReviewOptions {
  coordinatorId?: string;
}

interface CaseContext {
  system: string;
  jsonFolder: string;
  selectedFolder: string;
  discardedFolder: string;
}

interface WaitingRow {
  email_hash: string;
  rereview_coordinator_id: string | null;
}

async function caseContext(coordinatorId: string): Promise<CaseContext | null> {
  const row = await prisma.processedFile.findUnique({
    where: { id: coordinatorId },
    select: {
      filepath: true,
      subject_name: true,
      subject_email: true,
      subject_personal_email: true,
      subject_aliases: true,
    },
  });
  if (!row?.filepath) return null;
  const folder = path.join(
    getPstWorkFolder({
      fileId: coordinatorId,
      filepath: row.filepath,
      stagingPath:
        process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area",
      extractedPath:
        process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails",
    }),
    ".unique-emails",
  );
  const system = buildEmailAuditSystemPrompt({
    name: row.subject_name || "",
    email: row.subject_email || "",
    personalEmail: row.subject_personal_email || undefined,
    aliases: row.subject_aliases
      ? row.subject_aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : [],
  });
  return {
    system,
    jsonFolder: path.join(folder, "json-files"),
    selectedFolder: path.join(folder, "selected"),
    discardedFolder: path.join(folder, "discarded"),
  };
}

/** A provisional discard lives in discarded/; a kept one moves to selected/. */
function moveDiscardedToSelected(ctx: CaseContext, emailHash: string): void {
  const from = path.join(ctx.discardedFolder, `${emailHash}.eml`);
  const to = path.join(ctx.selectedFolder, `${emailHash}.eml`);
  fs.mkdirSync(ctx.selectedFolder, { recursive: true });
  if (fs.existsSync(from)) fs.renameSync(from, to);
}

/** Recomputes the case-level counters from the durable email rows. */
async function recountEmailAudit(coordinatorId: string): Promise<void> {
  const ids = await getCasePstFileIds(coordinatorId);
  const [approved, discarded] = await Promise.all([
    prisma.email.count({
      where: { file_id: { in: ids }, is_duplicate: 0, ai_decision: "keep" },
    }),
    prisma.email.count({
      where: { file_id: { in: ids }, is_duplicate: 0, ai_decision: "discard" },
    }),
  ]);
  await prisma.processedFile.update({
    where: { id: coordinatorId },
    data: { ai_approved_count: approved, ai_discarded_count: discarded },
  });
}

/**
 * Second opinion (Haiku 5.5, Converse) on the Haiku 4.5 discards the gate
 * queued. 5.5 keeps -> the email moves to selected/; 5.5 discards -> the
 * discard is confirmed; any failure -> the email is kept (a person reviews what
 * is delivered, and the audit errs toward keeping). When the last waiting
 * discard of a case settles and the audit has no other work, the case moves on
 * to attachment screening and Render. Safe to run from several processes: rows
 * are claimed with an atomic update and stale claims are reclaimed.
 */
export async function rereviewEmailDiscards(
  options: EmailRereviewOptions = {},
): Promise<number> {
  const scope = options.coordinatorId
    ? { rereview_coordinator_id: options.coordinatorId }
    : {};
  const touched = new Set<string>();
  const contexts = new Map<string, CaseContext | null>();

  const getContext = async (
    coordinatorId: string | null,
  ): Promise<CaseContext | null> => {
    if (!coordinatorId) return null;
    if (!contexts.has(coordinatorId)) {
      contexts.set(coordinatorId, await caseContext(coordinatorId));
    }
    return contexts.get(coordinatorId) ?? null;
  };

  const settleRow = async (
    row: WaitingRow,
    decision: "keep" | "discard",
    reason: string,
  ): Promise<void> => {
    if (decision === "keep") {
      const ctx = await getContext(row.rereview_coordinator_id);
      if (ctx) moveDiscardedToSelected(ctx, row.email_hash);
    }
    await decideEmail({
      emailHash: row.email_hash,
      decision,
      rule: "ai_email",
      reason: reason.slice(0, 240),
      decidedBy: "haiku-5.5",
      guard: { rereview_status: "running" },
      emailData: { rereview_status: null, rereview_started_at: null },
    });
    if (row.rereview_coordinator_id) touched.add(row.rereview_coordinator_id);
  };

  const adapter: SecondReviewAdapter<WaitingRow> = {
    name: "Email Rereview",
    testConverse: emailAiTestOverride.converse,
    async reclaimStale(cutoff) {
      await prisma.email.updateMany({
        where: {
          ...scope,
          rereview_status: "running",
          rereview_started_at: { lt: cutoff },
        },
        data: { rereview_status: "pending", rereview_started_at: null },
      });
    },
    async giveUpWithoutCredentials(cutoff) {
      // No credentials: keep waiting, but never strand an email forever.
      const stranded = await prisma.email.findMany({
        where: {
          ...scope,
          rereview_status: "pending",
          rereview_queued_at: { lt: cutoff },
        },
        select: { email_hash: true, rereview_coordinator_id: true },
      });
      let count = 0;
      for (const row of stranded) {
        const claim = await prisma.email.updateMany({
          where: { email_hash: row.email_hash, rereview_status: "pending" },
          data: { rereview_status: "running" },
        });
        if (claim.count === 0) continue;
        await settleRow(
          row,
          "keep",
          "Second review unavailable (no AWS credentials); kept for human review.",
        );
        count++;
      }
      return count;
    },
    async claim(take, stamp) {
      const candidates = await prisma.email.findMany({
        where: { ...scope, rereview_status: "pending" },
        orderBy: { rereview_queued_at: "asc" },
        take,
        select: { email_hash: true },
      });
      if (candidates.length === 0) return null;
      const hashes = candidates.map((row) => row.email_hash);
      await prisma.email.updateMany({
        where: { email_hash: { in: hashes }, rereview_status: "pending" },
        data: { rereview_status: "running", rereview_started_at: stamp },
      });
      return prisma.email.findMany({
        where: {
          email_hash: { in: hashes },
          rereview_status: "running",
          rereview_started_at: stamp,
        },
        select: { email_hash: true, rereview_coordinator_id: true },
      });
    },
    async settle(row, call) {
      const ctx = await getContext(row.rereview_coordinator_id);
      const jsonPath = ctx
        ? path.join(ctx.jsonFolder, `${row.email_hash}.json`)
        : "";
      if (!ctx || !fs.existsSync(jsonPath)) {
        await settleRow(
          row,
          "keep",
          "Second review could not read the email; kept for human review.",
        );
        return;
      }
      let raw: unknown;
      try {
        const content = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<
          string,
          unknown
        >;
        stripPayloadSignatures(content);
        raw = await call(
          {
            customId: row.email_hash,
            system: ctx.system,
            user: JSON.stringify(content),
            toolName: "dsar_audit_decision",
            schema: RESPONSE_FORMAT.json_schema.schema as Record<
              string,
              unknown
            >,
            maxTokens: 300,
          },
          CONVERSE_MODEL,
        );
      } catch (error) {
        console.error(
          "[Email Rereview] Second review call failed:",
          (error as { name?: string }).name,
        );
      }
      const out = raw as
        | { decision?: string; reason?: string; sensitivity?: string }
        | undefined;
      if (!out || (out.decision !== "keep" && out.decision !== "discard")) {
        await settleRow(
          row,
          "keep",
          "Second review failed; kept for human review.",
        );
        return;
      }
      const audited = applyConfidentiality({
        decision: out.decision,
        reason: out.reason || "Second review.",
        needsSecondPass: false,
        sensitivity: out.sensitivity,
      });
      await settleRow(
        row,
        audited.decision,
        audited.decision === "keep"
          ? `Kept on second review (Haiku 5.5): ${audited.reason}`
          : `Confirmed on second review (Haiku 5.5): ${audited.reason}`,
      );
    },
    async finish() {
      // A case whose last waiting discard settled moves on, if nothing else holds it.
      for (const coordinatorId of touched) {
        await recountEmailAudit(coordinatorId);
        const ids = await getCasePstFileIds(coordinatorId);
        if (await emailRereviewPending(ids)) continue;
        const [undecided, active, coordinator] = await Promise.all([
          prisma.email.count({
            where: { file_id: { in: ids }, is_duplicate: 0, ai_decision: null },
          }),
          prisma.aiBatchRun.count({
            where: {
              coordinator_id: coordinatorId,
              status: { in: ["claiming", "submitted", "processing"] },
            },
          }),
          prisma.processedFile.findUnique({
            where: { id: coordinatorId },
            select: { ai_status: true, mail_screen_status: true },
          }),
        ]);
        if (
          undecided === 0 &&
          active === 0 &&
          coordinator?.ai_status === "processing" &&
          coordinator.mail_screen_status === "none"
        ) {
          await completeEmailAudit(coordinatorId);
        }
      }
    },
  };

  return runSecondReview(adapter, options);
}

export async function emailRereviewWorkRemains(): Promise<boolean> {
  const waiting = await prisma.email.findFirst({
    where: { rereview_status: { not: null } },
    select: { email_hash: true },
  });
  return !!waiting;
}
