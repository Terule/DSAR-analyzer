import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { encodingForModel } from "js-tiktoken";
import OpenAI from "openai";
import { AI_TOKENIZER_MODEL } from "./ai-model";
import {
  BEDROCK_BATCH_PREFIX,
  BEDROCK_CONVERSE_PREFIX,
  REREVIEW_DEFAULT_MIN_P_KEEP,
  REREVIEW_DEFAULT_SAMPLE_PERCENT,
} from "./bedrock/config";
import { shouldRereview } from "./bedrock/rereview-gate";
import { runtimeCredentials } from "./credentials";
import {
  type FilesAiCandidate,
  listFilesAiCandidates,
  readPdfSample,
} from "./files-ai-extract";
import {
  buildFilesAiBatchRequest,
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  decideFilesAi,
  type FilesAiCriteria,
  type FilesAiMode,
  parseFilesAiJudgement,
} from "./files-ai-prompt";
import {
  buildSample,
  subjectClearlyInvolved,
  subjectMentionTokens,
} from "./files-ai-text";
import {
  DEFAULT_AI_BATCH_SETTINGS,
  getAiBatchSettings,
} from "./pipeline-settings";
import { prisma } from "./prisma";

const TOKENIZER = encodingForModel(AI_TOKENIZER_MODEL);
/**
 * A PDF with more pages than this is judged from a sample only (the start plus
 * the lines that mention the subject). If the sample is relevant and not
 * confidential, a person reviews it.
 */
export function largeFilePages(): number {
  const value = Number(process.env.FILES_AI_LARGE_FILE_PAGES);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

/**
 * Employee cases are judged for relevance and confidentiality; client cases
 * only for confidentiality.
 */
export async function filesAiModeFor(fileId: string): Promise<FilesAiMode> {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: {
      case_request: { select: { case: { select: { case_type: true } } } },
    },
  });
  return row?.case_request?.case.case_type === "client" ? "client" : "employee";
}

/** Email bodies and attachments are keyed `mail:<content hash>`. */
export const MAIL_ITEM_PREFIX = "mail:";
export function isMailItem(relPath: string): boolean {
  return relPath.startsWith(MAIL_ITEM_PREFIX);
}

const REQUEST_OVERHEAD_TOKENS = 24;
const MESSAGE_OVERHEAD_TOKENS = 12;

/** A thin seam over the OpenAI SDK so the batch flow can be tested offline. */
export interface FilesAiClient {
  uploadBatchFile(filePath: string): Promise<string>;
  createBatch(inputFileId: string): Promise<string>;
  retrieveBatch(
    batchId: string,
  ): Promise<{ status: string; outputFileId?: string | null }>;
  readFile(fileId: string): Promise<string>;
}

export interface PrepareFilesAiInput {
  fileId: string;
  dirs: { messagesDir: string; documentsDir: string };
  criteria: FilesAiCriteria;
  client: FilesAiClient;
  mode?: FilesAiMode;
  /** Explicit items (email bodies and attachments); defaults to the converted PDFs of this wave. */
  candidates?: FilesAiCandidate[];
  maxTokensPerBatch?: number;
  batchDir?: string;
  /** Overridable so tests need no real PDFs. */
  readText?: (absPath: string) => Promise<string>;
  /** Like `readText` but also reports the page count (tests). */
  readSample?: (
    absPath: string,
  ) => Promise<{ text: string; totalPages: number }>;
}

interface QueuedRequest {
  id: string;
  line: string;
  tokens: number;
}

function verdictId(fileId: string, relPath: string): string {
  return `${fileId}:${relPath}`;
}

/**
 * Builds a keep/discard request for every converted file of this wave that has
 * no verdict yet and submits them as OpenAI Batch runs. Safe to call again:
 * files that already have a verdict, or are in a submitted run, are skipped;
 * rows left pending and unclaimed by a failed submit are queued again.
 */
export async function prepareFilesAi(input: PrepareFilesAiInput): Promise<{
  candidates: number;
  queued: number;
  keptNoText: number;
  submittedBatches: number;
}> {
  const { fileId, dirs, criteria, client } = input;
  const mode = input.mode ?? (await filesAiModeFor(fileId));
  const readText = input.readText;
  const maxTokens =
    input.maxTokensPerBatch ??
    (await getAiBatchSettings()).maxTokensPerBatch ??
    DEFAULT_AI_BATCH_SETTINGS.maxTokensPerBatch;
  const candidates = input.candidates ?? listFilesAiCandidates(dirs);
  const existing = new Map(
    (
      await prisma.filesAiVerdict.findMany({
        where: { file_id: fileId },
        select: { rel_path: true, verdict: true, batch_run_id: true },
      })
    ).map((row) => [row.rel_path, row]),
  );
  const systemPrompt = buildFilesAiSystemPrompt(criteria, mode);
  const mentionTokens = subjectMentionTokens(criteria);
  const systemTokens = TOKENIZER.encode(systemPrompt).length;

  let keptNoText = 0;
  const queue: QueuedRequest[] = [];
  for (const candidate of candidates) {
    const known = existing.get(candidate.relPath);
    if (known && (known.verdict !== null || known.batch_run_id !== null)) {
      continue;
    }
    const id = verdictId(fileId, candidate.relPath);
    const resolveNow = async (
      verdict: "keep" | "review",
      reason: string,
      extra: { sampled?: boolean; largeFile?: boolean } = {},
    ) => {
      const data = {
        verdict,
        reason,
        sampled: extra.sampled ?? false,
        large_file: extra.largeFile ?? false,
        resolved_at: new Date(),
      };
      await prisma.filesAiVerdict.upsert({
        where: { id },
        create: { id, file_id: fileId, rel_path: candidate.relPath, ...data },
        update: data,
      });
    };

    const read = input.readSample
      ? await input.readSample(candidate.absPath)
      : readText
        ? { text: await readText(candidate.absPath), totalPages: 0 }
        : await readPdfSample(candidate.absPath);
    const text = read.text;
    if (!text.trim()) {
      // Nothing to read means nothing to screen: a person decides.
      await resolveNow(
        "review",
        "No extractable text; could not be screened, needs human review.",
      );
      keptNoText++;
      continue;
    }
    // Every file with text is screened for confidentiality. Being plainly
    // involved only protects against an "irrelevant" answer, never skips the AI.
    const subjectInvolved =
      mode === "employee" && subjectClearlyInvolved(text, criteria);
    const largeFile = read.totalPages > largeFilePages();
    const sample = buildSample(text, mentionTokens);
    const userContent = buildFilesAiUserContent({
      fileName: candidate.fileName,
      kind: candidate.kind,
      sampled: sample.sampled,
      text: sample.text,
    });
    const estimate =
      systemTokens +
      TOKENIZER.encode(userContent).length +
      2 * MESSAGE_OVERHEAD_TOKENS +
      REQUEST_OVERHEAD_TOKENS;
    if (estimate > maxTokens) {
      await resolveNow("review", "Too large to screen; needs human review.", {
        sampled: sample.sampled,
        largeFile: true,
      });
      continue;
    }
    if (!known) {
      await prisma.filesAiVerdict.create({
        data: {
          id,
          file_id: fileId,
          rel_path: candidate.relPath,
          sampled: sample.sampled,
          subject_involved: subjectInvolved,
          large_file: largeFile,
        },
      });
    }
    queue.push({
      id,
      line: JSON.stringify(
        buildFilesAiBatchRequest({ customId: id, systemPrompt, userContent }),
      ),
      tokens: estimate,
    });
  }

  const chunks: QueuedRequest[][] = [];
  let current: QueuedRequest[] = [];
  let currentTokens = 0;
  for (const item of queue) {
    if (current.length > 0 && currentTokens + item.tokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += item.tokens;
  }
  if (current.length > 0) chunks.push(current);

  for (const chunk of chunks) {
    await submitChunk(fileId, chunk, client, input.batchDir);
  }
  return {
    candidates: candidates.length,
    queued: queue.length,
    keptNoText,
    submittedBatches: chunks.length,
  };
}

async function submitChunk(
  fileId: string,
  chunk: QueuedRequest[],
  client: FilesAiClient,
  batchDir?: string,
): Promise<void> {
  const runId = randomUUID();
  const jsonlPath = runJsonlPath(runId, batchDir);
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  // The run row exists before the claim so the verdict foreign key holds.
  await prisma.filesAiBatchRun.create({
    data: { id: runId, file_id: fileId, status: "claiming" },
  });
  try {
    const ids = chunk.map((item) => item.id);
    const claim = await prisma.filesAiVerdict.updateMany({
      where: { id: { in: ids }, verdict: null, batch_run_id: null },
      data: { batch_run_id: runId },
    });
    if (claim.count !== ids.length) {
      throw new Error("Files AI claim raced with another submitter.");
    }
    fs.writeFileSync(
      jsonlPath,
      `${chunk.map((item) => item.line).join("\n")}\n`,
    );
    const inputFileId = await client.uploadBatchFile(jsonlPath);
    const batchId = await client.createBatch(inputFileId);
    await prisma.filesAiBatchRun.update({
      where: { id: runId },
      data: {
        status: "submitted",
        openai_batch_id: batchId,
        request_count: chunk.length,
        estimated_tokens: chunk.reduce((sum, item) => sum + item.tokens, 0),
        submitted_at: new Date(),
      },
    });
  } catch (error) {
    await prisma.filesAiVerdict.updateMany({
      where: { batch_run_id: runId, verdict: null },
      data: { batch_run_id: null },
    });
    await prisma.filesAiBatchRun.delete({ where: { id: runId } });
    fs.rmSync(jsonlPath, { force: true });
    throw error;
  }
  // On success the request file stays on disk: it is what a failed or expired
  // batch is resubmitted from. It is removed once the run reaches a final state.
}

/** Where a run's batch input is kept (shared `batches/` mount by default). */
export function runJsonlPath(runId: string, batchDir?: string): string {
  return path.join(
    batchDir ?? path.join(process.cwd(), "batches"),
    `files-ai-${runId}.jsonl`,
  );
}

/**
 * Removes a run's request file and every artifact a provider keeps beside it
 * (`files-ai-<runId>.*`, e.g. the Bedrock record map and cached output).
 */
export function removeRunFiles(runId: string, batchDir?: string): void {
  const jsonl = runJsonlPath(runId, batchDir);
  const dir = path.dirname(jsonl);
  const prefix = `${path.basename(jsonl, ".jsonl")}.`;
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefix))
      fs.rmSync(path.join(dir, name), { force: true });
  }
}

/** A batch OpenAI failed, expired or cancelled is resubmitted this many runs in. */
const MAX_RUN_ATTEMPTS = 2;

/**
 * Resubmits a failed/expired/cancelled batch once with the very same requests.
 * Past the limit, or when anything about the resubmission goes wrong, the run is
 * failed and its files go to human review (the previous behaviour).
 */
async function retryOrFailRun(
  run: {
    id: string;
    file_id: string;
    attempt: number;
    request_count: number;
    estimated_tokens: number;
  },
  reason: string,
  client: FilesAiClient,
  batchDir?: string,
): Promise<void> {
  const oldPath = runJsonlPath(run.id, batchDir);
  if (run.attempt >= MAX_RUN_ATTEMPTS || !fs.existsSync(oldPath)) {
    await failFilesAiRun(run.id, reason);
    return;
  }
  const newId = randomUUID();
  const newPath = runJsonlPath(newId, batchDir);
  try {
    fs.copyFileSync(oldPath, newPath);
    await prisma.filesAiBatchRun.create({
      data: {
        id: newId,
        file_id: run.file_id,
        status: "claiming",
        attempt: run.attempt + 1,
      },
    });
    const batchId = await client.createBatch(
      await client.uploadBatchFile(newPath),
    );
    // Only once the new batch exists do the files move over, in one step.
    await prisma.$transaction([
      prisma.filesAiVerdict.updateMany({
        where: { batch_run_id: run.id, verdict: null },
        data: { batch_run_id: newId },
      }),
      prisma.filesAiBatchRun.update({
        where: { id: newId },
        data: {
          status: "submitted",
          openai_batch_id: batchId,
          request_count: run.request_count,
          estimated_tokens: run.estimated_tokens,
          submitted_at: new Date(),
        },
      }),
      prisma.filesAiBatchRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          error: `${reason} Resubmitted once.`,
          completed_at: new Date(),
        },
      }),
    ]);
    fs.rmSync(oldPath, { force: true });
    console.warn(
      `[Files AI] ${reason} Resubmitted ${run.request_count} request(s) as batch ${batchId}.`,
    );
  } catch (error) {
    console.warn(`[Files AI] Could not resubmit run ${run.id}: ${error}`);
    await prisma.filesAiBatchRun.deleteMany({
      where: { id: newId, status: "claiming" },
    });
    fs.rmSync(newPath, { force: true });
    await failFilesAiRun(run.id, reason);
  }
}

/** Sends a run's pending files to human review and marks the run failed. */
export async function failFilesAiRun(
  runId: string,
  error: string,
): Promise<void> {
  await prisma.filesAiVerdict.updateMany({
    where: { batch_run_id: runId, verdict: null },
    data: {
      verdict: "review",
      reason: "AI batch failed; needs human review.",
      resolved_at: new Date(),
    },
  });
  await prisma.filesAiBatchRun.update({
    where: { id: runId },
    data: { status: "failed", error, completed_at: new Date() },
  });
  fs.rmSync(runJsonlPath(runId), { force: true });
  removeRunFiles(runId);
}

/**
 * Sends every file that was never handed to a batch (pending and unclaimed) to
 * human review.
 * Used when the prepare job dead-lettered: those files will not be submitted,
 * but batches that did go out are still read.
 */
export async function reviewUnsubmittedFiles(fileId: string): Promise<number> {
  const result = await prisma.filesAiVerdict.updateMany({
    where: { file_id: fileId, verdict: null, batch_run_id: null },
    data: {
      verdict: "review",
      reason: "AI step failed; needs human review.",
      resolved_at: new Date(),
    },
  });
  return result.count;
}

/** Applies the output of every finished batch of this Files row. */
export async function pollFilesAiBatches(
  fileId: string,
  client: FilesAiClient,
  batchDir?: string,
): Promise<void> {
  const mode = await filesAiModeFor(fileId);
  const settings = await getAiBatchSettings();
  const rereviewConfig = {
    minPKeep: settings.rereviewMinPKeep ?? REREVIEW_DEFAULT_MIN_P_KEEP,
    sampleRate:
      (settings.rereviewSamplePercent ?? REREVIEW_DEFAULT_SAMPLE_PERCENT) / 100,
  };
  const runs = await prisma.filesAiBatchRun.findMany({
    where: {
      file_id: fileId,
      status: { in: ["submitted", "processing"] },
      openai_batch_id: { not: null },
    },
  });
  for (const run of runs) {
    const batch = await client.retrieveBatch(run.openai_batch_id as string);
    if (["failed", "expired", "cancelled"].includes(batch.status)) {
      await retryOrFailRun(
        run,
        `OpenAI batch ${batch.status}.`,
        client,
        batchDir,
      );
      continue;
    }
    if (batch.status !== "completed") continue;
    if (!batch.outputFileId) {
      await failFilesAiRun(run.id, "Batch completed without an output file.");
      continue;
    }
    const text = await client.readFile(batch.outputFileId);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: {
        custom_id?: string;
        response?: {
          body?: { choices?: Array<{ message?: { content?: string } }> };
        };
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed.custom_id) continue;
      const judgement = parseFilesAiJudgement(
        parsed.response?.body?.choices?.[0]?.message?.content,
      );
      const row = await prisma.filesAiVerdict.findFirst({
        where: { id: parsed.custom_id, verdict: null },
        select: { subject_involved: true, large_file: true, rel_path: true },
      });
      if (!row) continue;
      const decision = decideFilesAi({
        judgement,
        mode: isMailItem(row.rel_path) ? "mail" : mode,
        largeFile: row.large_file,
        subjectInvolved: row.subject_involved,
      });
      // A Haiku 4.5 (Bedrock Batch) discard that shows doubt waits for a second
      // opinion from Haiku 5.5 instead of being final.
      const fromBatch45 = String(run.openai_batch_id).startsWith(
        BEDROCK_BATCH_PREFIX,
      );
      if (
        fromBatch45 &&
        decision.verdict === "discard" &&
        shouldRereview(
          {
            id: parsed.custom_id,
            pKeep: judgement.confidence,
            sensitivity: judgement.sensitivity,
            subjectInvolved: row.subject_involved,
          },
          rereviewConfig,
        )
      ) {
        await prisma.filesAiVerdict.updateMany({
          where: { id: parsed.custom_id, verdict: null },
          data: {
            rereview_status: "pending",
            rereview_queued_at: new Date(),
            p_keep: judgement.confidence ?? null,
            first_reason: decision.reason,
            relevance: judgement.relevance,
            sensitivity: judgement.sensitivity,
            reviewed_by_model: "haiku-4.5",
          },
        });
        continue;
      }
      await prisma.filesAiVerdict.updateMany({
        where: { id: parsed.custom_id, verdict: null },
        data: {
          verdict: decision.verdict,
          reason: decision.reason,
          relevance: judgement.relevance,
          sensitivity: judgement.sensitivity,
          p_keep: judgement.confidence ?? null,
          reviewed_by_model: fromBatch45
            ? "haiku-4.5"
            : String(run.openai_batch_id).startsWith(BEDROCK_CONVERSE_PREFIX)
              ? "haiku-5.5"
              : null,
          resolved_at: new Date(),
        },
      });
    }
    // Anything the output did not mention goes to a person.
    await prisma.filesAiVerdict.updateMany({
      where: { batch_run_id: run.id, verdict: null, rereview_status: null },
      data: {
        verdict: "review",
        reason: "No AI result returned; needs human review.",
        resolved_at: new Date(),
      },
    });
    await prisma.filesAiBatchRun.update({
      where: { id: run.id },
      data: { status: "completed", completed_at: new Date() },
    });
    // Discards waiting for a second opinion are re-read from this request file.
    const waiting = await prisma.filesAiVerdict.count({
      where: { batch_run_id: run.id, rereview_status: { not: null } },
    });
    if (waiting === 0) {
      fs.rmSync(runJsonlPath(run.id, batchDir), { force: true });
      removeRunFiles(run.id, batchDir);
    }
  }
}

export async function getFilesAiState(fileId: string): Promise<{
  total: number;
  resolved: number;
  pending: number;
  discards: number;
  activeRuns: number;
  failedRuns: number;
}> {
  const [total, pending, discards, activeRuns, failedRuns] = await Promise.all([
    prisma.filesAiVerdict.count({ where: { file_id: fileId } }),
    prisma.filesAiVerdict.count({ where: { file_id: fileId, verdict: null } }),
    prisma.filesAiVerdict.count({
      where: { file_id: fileId, verdict: "discard" },
    }),
    prisma.filesAiBatchRun.count({
      where: {
        file_id: fileId,
        status: { in: ["claiming", "submitted", "processing"] },
      },
    }),
    prisma.filesAiBatchRun.count({
      where: { file_id: fileId, status: "failed" },
    }),
  ]);
  return {
    total,
    resolved: total - pending,
    pending,
    discards,
    activeRuns,
    failedRuns,
  };
}

export async function isFilesAiSettled(fileId: string): Promise<boolean> {
  const state = await getFilesAiState(fileId);
  return state.pending === 0 && state.activeRuns === 0;
}

export async function openAiFilesAiClient(): Promise<FilesAiClient> {
  const key = (await runtimeCredentials()).openAiKey;
  if (!key) throw new Error("Configure the OpenAI API key in Settings.");
  const openai = new OpenAI({ apiKey: key });
  return {
    async uploadBatchFile(filePath) {
      const upload = await openai.files.create({
        file: fs.createReadStream(filePath),
        purpose: "batch",
      });
      return upload.id;
    },
    async createBatch(inputFileId) {
      const batch = await openai.batches.create({
        input_file_id: inputFileId,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      });
      return batch.id;
    },
    async retrieveBatch(batchId) {
      const batch = await openai.batches.retrieve(batchId);
      return { status: batch.status, outputFileId: batch.output_file_id };
    },
    async readFile(fileId) {
      return (await openai.files.content(fileId)).text();
    },
  };
}

/**
 * With no way to screen (no OpenAI key), nothing may be delivered unchecked:
 * every converted file of this wave goes to human review instead.
 */
export async function sendCandidatesToReview(
  fileId: string,
  dirs: { messagesDir: string; documentsDir: string },
  reason: string,
): Promise<number> {
  return sendItemsToReview(fileId, listFilesAiCandidates(dirs), reason);
}

/** Same as `sendCandidatesToReview` for an explicit list (email bodies, attachments). */
export async function sendItemsToReview(
  fileId: string,
  candidates: FilesAiCandidate[],
  reason: string,
): Promise<number> {
  for (const candidate of candidates) {
    const id = verdictId(fileId, candidate.relPath);
    const data = { verdict: "review", reason, resolved_at: new Date() };
    await prisma.filesAiVerdict.upsert({
      where: { id },
      create: { id, file_id: fileId, rel_path: candidate.relPath, ...data },
      update: data,
    });
  }
  return candidates.length;
}
