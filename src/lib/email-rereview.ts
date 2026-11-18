import fs from "node:fs";
import path from "node:path";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  buildEmailAuditSystemPrompt,
  emailAiTestOverride,
  RESPONSE_FORMAT,
  stripPayloadSignatures,
} from "./ai";
import { completeEmailAudit, emailRereviewPending } from "./batch-worker";
import { CONVERSE_MODEL, converseConcurrency } from "./bedrock/config";
import { awsBedrockDeps } from "./bedrock/files-ai-client";
import type { ParsedRequest } from "./bedrock/translate";
import { getCasePstFileIds } from "./case-utils";
import { applyConfidentiality } from "./email-audit";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";

/** A claim older than this was left by a worker that died; it is queued again. */
const STALE_RUNNING_MS = 15 * 60_000;
/** Without AWS credentials for this long, waiting discards are kept for a person. */
const NO_CREDENTIALS_GIVE_UP_MS = 30 * 60_000;
const CHUNK = 200;
/** One call works through the backlog for at most this long, then yields to the sweep. */
const TIME_BUDGET_MS = 90_000;

type Converse = (request: ParsedRequest, modelId: string) => Promise<unknown>;

export interface EmailRereviewOptions {
  /** One Converse call with a forced tool; defaults to AWS Bedrock. */
  converse?: Converse;
  coordinatorId?: string;
  timeBudgetMs?: number;
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

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
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
  const started = Date.now();
  await prisma.email.updateMany({
    where: {
      ...scope,
      rereview_status: "running",
      rereview_started_at: { lt: new Date(started - STALE_RUNNING_MS) },
    },
    data: { rereview_status: "pending", rereview_started_at: null },
  });

  let converse: Converse | undefined =
    options.converse ?? emailAiTestOverride.converse;
  if (!converse) {
    try {
      await defaultProvider()();
      converse = awsBedrockDeps().converse;
    } catch {
      converse = undefined;
    }
  }

  const touched = new Set<string>();
  const contexts = new Map<string, CaseContext | null>();
  let settled = 0;

  const getContext = async (
    coordinatorId: string | null,
  ): Promise<CaseContext | null> => {
    if (!coordinatorId) return null;
    if (!contexts.has(coordinatorId)) {
      contexts.set(coordinatorId, await caseContext(coordinatorId));
    }
    return contexts.get(coordinatorId) ?? null;
  };

  const settle = async (
    row: WaitingRow,
    decision: "keep" | "discard",
    reason: string,
  ): Promise<void> => {
    if (decision === "keep") {
      const ctx = await getContext(row.rereview_coordinator_id);
      if (ctx) moveDiscardedToSelected(ctx, row.email_hash);
    }
    await prisma.email.updateMany({
      where: { email_hash: row.email_hash, rereview_status: "running" },
      data: {
        ai_decision: decision,
        ai_reason: reason.slice(0, 240),
        rereview_status: null,
        rereview_started_at: null,
      },
    });
    if (row.rereview_coordinator_id) touched.add(row.rereview_coordinator_id);
    settled++;
  };

  if (!converse) {
    // No credentials: keep waiting, but never strand an email forever.
    const stranded = await prisma.email.findMany({
      where: {
        ...scope,
        rereview_status: "pending",
        rereview_queued_at: {
          lt: new Date(started - NO_CREDENTIALS_GIVE_UP_MS),
        },
      },
      select: { email_hash: true, rereview_coordinator_id: true },
    });
    for (const row of stranded) {
      const claim = await prisma.email.updateMany({
        where: { email_hash: row.email_hash, rereview_status: "pending" },
        data: { rereview_status: "running" },
      });
      if (claim.count === 0) continue;
      await settle(
        row,
        "keep",
        "Second review unavailable (no AWS credentials); kept for human review.",
      );
    }
  } else {
    const call = converse;
    const budget = options.timeBudgetMs ?? TIME_BUDGET_MS;
    while (Date.now() - started < budget) {
      const candidates = await prisma.email.findMany({
        where: { ...scope, rereview_status: "pending" },
        orderBy: { rereview_queued_at: "asc" },
        take: CHUNK,
        select: { email_hash: true },
      });
      if (candidates.length === 0) break;
      const hashes = candidates.map((row) => row.email_hash);
      const stamp = new Date();
      await prisma.email.updateMany({
        where: { email_hash: { in: hashes }, rereview_status: "pending" },
        data: { rereview_status: "running", rereview_started_at: stamp },
      });
      const rows = await prisma.email.findMany({
        where: {
          email_hash: { in: hashes },
          rereview_status: "running",
          rereview_started_at: stamp,
        },
        select: { email_hash: true, rereview_coordinator_id: true },
      });

      await mapLimit(rows, converseConcurrency(), async (row) => {
        const ctx = await getContext(row.rereview_coordinator_id);
        const jsonPath = ctx
          ? path.join(ctx.jsonFolder, `${row.email_hash}.json`)
          : "";
        if (!ctx || !fs.existsSync(jsonPath)) {
          await settle(
            row,
            "keep",
            "Second review could not read the email; kept for human review.",
          );
          return;
        }
        let raw: unknown;
        try {
          const content = JSON.parse(
            fs.readFileSync(jsonPath, "utf8"),
          ) as Record<string, unknown>;
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
          await settle(
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
        await settle(
          row,
          audited.decision,
          audited.decision === "keep"
            ? `Kept on second review (Haiku 5.5): ${audited.reason}`
            : `Confirmed on second review (Haiku 5.5): ${audited.reason}`,
        );
      });
    }
  }

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
  return settled;
}

/** True while any discard waits for, or is getting, its second opinion. */
export async function emailRereviewWorkRemains(): Promise<boolean> {
  const waiting = await prisma.email.findFirst({
    where: { rereview_status: { not: null } },
    select: { email_hash: true },
  });
  return !!waiting;
}
