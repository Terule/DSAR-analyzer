import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { encodingForModel } from "js-tiktoken";
import OpenAI from "openai";
import { runtimeCredentials } from "./credentials";
import { listFilesAiCandidates, readPdfText } from "./files-ai-extract";
import {
  buildFilesAiBatchRequest,
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  FILES_AI_MODEL,
  type FilesAiCriteria,
  parseFilesAiVerdict,
} from "./files-ai-prompt";
import { buildSample, subjectMentionTokens } from "./files-ai-text";
import {
  DEFAULT_AI_BATCH_SETTINGS,
  getAiBatchSettings,
} from "./pipeline-settings";
import { prisma } from "./prisma";

const TOKENIZER = encodingForModel(FILES_AI_MODEL);
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
  maxTokensPerBatch?: number;
  batchDir?: string;
  /** Overridable so tests need no real PDFs. */
  readText?: (absPath: string) => Promise<string>;
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
  const readText = input.readText ?? readPdfText;
  const maxTokens =
    input.maxTokensPerBatch ??
    (await getAiBatchSettings()).maxTokensPerBatch ??
    DEFAULT_AI_BATCH_SETTINGS.maxTokensPerBatch;
  const candidates = listFilesAiCandidates(dirs);
  const existing = new Map(
    (
      await prisma.filesAiVerdict.findMany({
        where: { file_id: fileId },
        select: { rel_path: true, verdict: true, batch_run_id: true },
      })
    ).map((row) => [row.rel_path, row]),
  );
  const systemPrompt = buildFilesAiSystemPrompt(criteria);
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
    const keepNow = async (reason: string, sampled = false) => {
      await prisma.filesAiVerdict.upsert({
        where: { id },
        create: {
          id,
          file_id: fileId,
          rel_path: candidate.relPath,
          verdict: "keep",
          reason,
          sampled,
          resolved_at: new Date(),
        },
        update: { verdict: "keep", reason, sampled, resolved_at: new Date() },
      });
    };

    const text = await readText(candidate.absPath);
    if (!text.trim()) {
      await keepNow("No extractable text; kept without AI review.");
      keptNoText++;
      continue;
    }
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
      await keepNow("Too large to review; kept.", sample.sampled);
      continue;
    }
    if (!known) {
      await prisma.filesAiVerdict.create({
        data: {
          id,
          file_id: fileId,
          rel_path: candidate.relPath,
          sampled: sample.sampled,
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
  const dir = batchDir ?? path.join(process.cwd(), "batches");
  fs.mkdirSync(dir, { recursive: true });
  const jsonlPath = path.join(dir, `files-ai-${runId}.jsonl`);
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
    throw error;
  } finally {
    fs.rmSync(jsonlPath, { force: true });
  }
}

/** Resolves a run's pending files to keep and marks the run failed. */
export async function failFilesAiRun(
  runId: string,
  error: string,
): Promise<void> {
  await prisma.filesAiVerdict.updateMany({
    where: { batch_run_id: runId, verdict: null },
    data: {
      verdict: "keep",
      reason: "AI batch failed; kept.",
      resolved_at: new Date(),
    },
  });
  await prisma.filesAiBatchRun.update({
    where: { id: runId },
    data: { status: "failed", error, completed_at: new Date() },
  });
}

/**
 * Keeps every file that was never handed to a batch (pending and unclaimed).
 * Used when the prepare job dead-lettered: those files will not be submitted,
 * but batches that did go out are still read.
 */
export async function keepUnsubmittedFiles(fileId: string): Promise<number> {
  const result = await prisma.filesAiVerdict.updateMany({
    where: { file_id: fileId, verdict: null, batch_run_id: null },
    data: {
      verdict: "keep",
      reason: "AI step failed; kept.",
      resolved_at: new Date(),
    },
  });
  return result.count;
}

/** Applies the output of every finished batch of this Files row. */
export async function pollFilesAiBatches(
  fileId: string,
  client: FilesAiClient,
): Promise<void> {
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
      await failFilesAiRun(run.id, `OpenAI batch ${batch.status}.`);
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
      const verdict = parseFilesAiVerdict(
        parsed.response?.body?.choices?.[0]?.message?.content,
      );
      await prisma.filesAiVerdict.updateMany({
        where: { id: parsed.custom_id, verdict: null },
        data: { ...verdict, resolved_at: new Date() },
      });
    }
    // Anything the output did not mention is kept.
    await prisma.filesAiVerdict.updateMany({
      where: { batch_run_id: run.id, verdict: null },
      data: {
        verdict: "keep",
        reason: "No AI result returned; kept.",
        resolved_at: new Date(),
      },
    });
    await prisma.filesAiBatchRun.update({
      where: { id: run.id },
      data: { status: "completed", completed_at: new Date() },
    });
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
