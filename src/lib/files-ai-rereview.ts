import fs from "node:fs";
import { CONVERSE_MODEL } from "./bedrock/config";
import { parseRequestLine } from "./bedrock/translate";
import {
  filesAiModeFor,
  isMailItem,
  removeRunFiles,
  runJsonlPath,
} from "./files-ai";
import { decideFilesAi, parseFilesAiJudgement } from "./files-ai-prompt";
import { prisma } from "./prisma";
import {
  runSecondReview,
  type SecondReviewAdapter,
  type SecondReviewOptions,
} from "./second-review";

export interface RereviewOptions extends SecondReviewOptions {
  fileId?: string;
  batchDir?: string;
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
  const modes = new Map<string, Awaited<ReturnType<typeof filesAiModeFor>>>();
  const lineCache = new Map<string, Map<string, string>>();
  const touchedRuns = new Set<string>();

  type Row = {
    id: string;
    file_id: string;
    rel_path: string;
    batch_run_id: string | null;
    large_file: boolean;
    subject_involved: boolean;
    first_reason: string | null;
  };

  const adapter: SecondReviewAdapter<Row> = {
    name: "Files AI",
    async reclaimStale(cutoff) {
      await prisma.filesAiVerdict.updateMany({
        where: {
          ...scope,
          rereview_status: "running",
          rereview_started_at: { lt: cutoff },
        },
        data: { rereview_status: "pending", rereview_started_at: null },
      });
    },
    async giveUpWithoutCredentials(cutoff) {
      // No credentials: keep waiting, but never strand a file forever.
      await prisma.filesAiVerdict.updateMany({
        where: {
          ...scope,
          rereview_status: "pending",
          rereview_queued_at: { lt: cutoff },
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
    },
    async claim(take, stamp) {
      const candidates = await prisma.filesAiVerdict.findMany({
        where: { ...scope, rereview_status: "pending" },
        orderBy: { rereview_queued_at: "asc" },
        take,
        select: { id: true },
      });
      if (candidates.length === 0) return null;
      const ids = candidates.map((row) => row.id);
      await prisma.filesAiVerdict.updateMany({
        where: { id: { in: ids }, rereview_status: "pending" },
        data: { rereview_status: "running", rereview_started_at: stamp },
      });
      return prisma.filesAiVerdict.findMany({
        where: {
          id: { in: ids },
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
    },
    async settle(row, converse) {
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
    },
    async finish() {
      // A run's request file is kept until none of its discards waits for a second look.
      for (const runId of touchedRuns) {
        const waiting = await prisma.filesAiVerdict.count({
          where: { batch_run_id: runId, rereview_status: { not: null } },
        });
        if (waiting === 0) removeRunFiles(runId, options.batchDir);
      }
    },
  };

  return runSecondReview(adapter, options);
}

/** True while any discard waits for, or is getting, its second opinion. */
export async function rereviewWorkRemains(): Promise<boolean> {
  const waiting = await prisma.filesAiVerdict.findFirst({
    where: { rereview_status: { not: null } },
    select: { id: true },
  });
  return !!waiting;
}
