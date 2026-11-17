import fs from "node:fs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { CONVERSE_MODEL, converseConcurrency } from "./bedrock/config";
import { awsBedrockDeps } from "./bedrock/files-ai-client";
import { type ParsedRequest, parseRequestLine } from "./bedrock/translate";
import {
  filesAiModeFor,
  isMailItem,
  removeRunFiles,
  runJsonlPath,
} from "./files-ai";
import { decideFilesAi, parseFilesAiJudgement } from "./files-ai-prompt";
import { prisma } from "./prisma";

/** A claim older than this was left by a worker that died; it is queued again. */
const STALE_RUNNING_MS = 15 * 60_000;
/** Without AWS credentials for this long, waiting discards go to a person. */
const NO_CREDENTIALS_GIVE_UP_MS = 30 * 60_000;
const CHUNK = 200;
/** One call works through the backlog for at most this long, then yields to the sweep. */
const TIME_BUDGET_MS = 90_000;

export interface RereviewOptions {
  /** One Converse call with a forced tool; defaults to AWS Bedrock. */
  converse?: (request: ParsedRequest, modelId: string) => Promise<unknown>;
  fileId?: string;
  batchDir?: string;
  timeBudgetMs?: number;
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

function loadRequestLines(
  runId: string,
  batchDir?: string,
): Map<string, string> {
  const lines = new Map<string, string>();
  const file = runJsonlPath(runId, batchDir);
  if (!fs.existsSync(file)) return lines;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.set((JSON.parse(line) as { custom_id: string }).custom_id, line);
    } catch {
      // A damaged line has no result; its item goes to a person.
    }
  }
  return lines;
}

/**
 * Second opinion (Haiku 5.5, Converse) on the Haiku 4.5 discards the gate sent
 * here. 5.5 keeps -> the file is kept; 5.5 discards -> the discard is confirmed;
 * any failure -> a person decides. Safe to run from several processes: rows are
 * claimed with an atomic update and stale claims are reclaimed. Returns how many
 * verdicts were settled.
 */
export async function rereviewFilesAiDiscards(
  options: RereviewOptions = {},
): Promise<number> {
  const scope = options.fileId ? { file_id: options.fileId } : {};
  const started = Date.now();
  await prisma.filesAiVerdict.updateMany({
    where: {
      ...scope,
      rereview_status: "running",
      rereview_started_at: { lt: new Date(started - STALE_RUNNING_MS) },
    },
    data: { rereview_status: "pending", rereview_started_at: null },
  });

  let converse = options.converse;
  if (!converse) {
    try {
      await defaultProvider()();
      converse = awsBedrockDeps().converse;
    } catch {
      // No credentials: keep waiting, but never strand a file forever.
      await prisma.filesAiVerdict.updateMany({
        where: {
          ...scope,
          rereview_status: "pending",
          rereview_queued_at: {
            lt: new Date(started - NO_CREDENTIALS_GIVE_UP_MS),
          },
        },
        data: {
          verdict: "review",
          reason:
            "Second review unavailable (no AWS credentials); needs human review.",
          rereview_status: null,
          resolved_at: new Date(),
        },
      });
      return 0;
    }
  }

  const budget = options.timeBudgetMs ?? TIME_BUDGET_MS;
  const modes = new Map<string, Awaited<ReturnType<typeof filesAiModeFor>>>();
  const lineCache = new Map<string, Map<string, string>>();
  const touchedRuns = new Set<string>();
  let settled = 0;

  while (Date.now() - started < budget) {
    const candidates = await prisma.filesAiVerdict.findMany({
      where: { ...scope, rereview_status: "pending" },
      orderBy: { rereview_queued_at: "asc" },
      take: CHUNK,
      select: { id: true },
    });
    if (candidates.length === 0) break;
    const stamp = new Date();
    await prisma.filesAiVerdict.updateMany({
      where: {
        id: { in: candidates.map((row) => row.id) },
        rereview_status: "pending",
      },
      data: { rereview_status: "running", rereview_started_at: stamp },
    });
    const rows = await prisma.filesAiVerdict.findMany({
      where: {
        id: { in: candidates.map((row) => row.id) },
        rereview_status: "running",
        rereview_started_at: stamp,
      },
      select: {
        id: true,
        file_id: true,
        rel_path: true,
        batch_run_id: true,
        large_file: true,
        subject_involved: true,
        first_reason: true,
      },
    });

    await mapLimit(rows, converseConcurrency(), async (row) => {
      if (row.batch_run_id) {
        touchedRuns.add(row.batch_run_id);
        if (!lineCache.has(row.batch_run_id)) {
          lineCache.set(
            row.batch_run_id,
            loadRequestLines(row.batch_run_id, options.batchDir),
          );
        }
      }
      const line = row.batch_run_id
        ? lineCache.get(row.batch_run_id)?.get(row.id)
        : undefined;
      let verdict: "keep" | "discard" | "review" = "review";
      let reason = "Second review failed; needs human review.";
      let relevance: string | null = null;
      let sensitivity: string | null = null;
      if (line) {
        let raw: string | undefined;
        try {
          const input = await converse(parseRequestLine(line), CONVERSE_MODEL);
          raw = input === undefined ? undefined : JSON.stringify(input);
        } catch (error) {
          console.error(
            "[Files AI] Second review call failed:",
            (error as { name?: string }).name,
          );
        }
        const judgement = parseFilesAiJudgement(raw);
        if (judgement.relevance !== null) {
          if (!modes.has(row.file_id)) {
            modes.set(row.file_id, await filesAiModeFor(row.file_id));
          }
          const decision = decideFilesAi({
            judgement,
            mode: isMailItem(row.rel_path)
              ? "mail"
              : (modes.get(row.file_id) as "employee" | "client"),
            largeFile: row.large_file,
            subjectInvolved: row.subject_involved,
          });
          verdict = decision.verdict;
          reason =
            decision.verdict === "keep"
              ? `Kept on second review (Haiku 5.5): ${decision.reason}`
              : decision.verdict === "discard"
                ? `Confirmed on second review (Haiku 5.5): ${decision.reason}`
                : decision.reason;
          relevance = judgement.relevance;
          sensitivity = judgement.sensitivity;
        }
      } else {
        reason =
          "Request file missing for the second review; needs human review.";
      }
      await prisma.filesAiVerdict.updateMany({
        where: { id: row.id, rereview_status: "running" },
        data: {
          verdict,
          reason: reason.slice(0, 240),
          relevance,
          sensitivity,
          resolved_at: new Date(),
          rereview_status: null,
          reviewed_by_model: "haiku-5.5",
        },
      });
      settled++;
    });
  }

  // A run's request file is kept until none of its discards waits for a second look.
  for (const runId of touchedRuns) {
    const waiting = await prisma.filesAiVerdict.count({
      where: { batch_run_id: runId, rereview_status: { not: null } },
    });
    if (waiting === 0) removeRunFiles(runId, options.batchDir);
  }
  return settled;
}

/** True while any discard waits for, or is getting, its second opinion. */
export async function rereviewWorkRemains(): Promise<boolean> {
  const waiting = await prisma.filesAiVerdict.findFirst({
    where: { rereview_status: { not: null } },
    select: { id: true },
  });
  return !!waiting;
}
