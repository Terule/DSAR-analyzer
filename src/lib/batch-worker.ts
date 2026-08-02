import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { DEFAULT_MAX_TOKENS_PER_BATCH, fillAiBatchSlots } from "./ai";
import {
  getCasePstFileIds,
  isCaseAiSettled,
  markCaseAiCompleted,
  markCaseAiFailed,
} from "./case-utils";
import { enqueueFilePhase } from "./control-plane/pipeline";
import { runtimeCredentials } from "./credentials";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";

let openai: OpenAI | null = null;
async function getOpenAi(): Promise<OpenAI> {
  if (openai) return openai;
  const key = (await runtimeCredentials()).openAiKey;
  if (!key) throw new Error("Configure the OpenAI API key in Settings.");
  openai = new OpenAI({ apiKey: key });
  return openai;
}
const adaptiveTokenCapByFile = new Map<string, number>();
const MIN_RETRY_BATCH_TOKENS = 25_000;
const TOKEN_BACKOFF_FACTOR = 0.8;

interface AiPayloadSection {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
}

interface AiPayload {
  text?: string;
  first_email?: AiPayloadSection;
  second_email?: AiPayloadSection | null;
  rest_of_chain?: { text?: string };
  attachments?: Array<{
    filename?: string;
    content_type?: string;
    size_bytes?: number;
  }>;
  meta?: {
    attachment_count?: number;
    to_recipient_count?: number;
  };
}

interface SubjectCriteria {
  name?: string;
  email?: string;
  personalEmail?: string;
  aliases?: string[];
}

function criteriaFromRow(row: {
  subject_name: string | null;
  subject_email: string | null;
  subject_personal_email: string | null;
  subject_aliases: string | null;
}): Required<Pick<SubjectCriteria, "name" | "email" | "aliases">> &
  Pick<SubjectCriteria, "personalEmail"> {
  return {
    name: row.subject_name || "",
    email: row.subject_email || "",
    personalEmail: row.subject_personal_email || undefined,
    aliases: row.subject_aliases
      ? row.subject_aliases
          .split(",")
          .map((alias) => alias.trim())
          .filter(Boolean)
      : [],
  };
}

function getBatchErrorText(batch: OpenAI.Batches.Batch): string {
  const data = batch.errors?.data;
  if (!data || data.length === 0) return "";

  return data
    .map((item) => `${item.code || ""} ${item.message || ""}`.trim())
    .join(" ")
    .toLowerCase();
}

function isExpiredBatchFailure(batch: OpenAI.Batches.Batch): boolean {
  if (batch.status === "expired") return true;
  if (batch.status !== "failed") return false;

  const errorText = getBatchErrorText(batch);
  return /expired|expiration|completion_window/.test(errorText);
}

function isTokenLimitBatchFailure(batch: OpenAI.Batches.Batch): boolean {
  if (batch.status !== "failed") return false;
  const errorText = getBatchErrorText(batch);
  return /token|enqueued|rate.?limit|max.*tokens|too many tokens/.test(
    errorText,
  );
}

function parseLimitTokens(errorText: string): number | null {
  const patterns = [
    /limit[^\d]*(\d[\d,]*)/i,
    /max(?:imum)?[^\d]*(\d[\d,]*)\s*tokens?/i,
    /allowed[^\d]*(\d[\d,]*)\s*tokens?/i,
  ];

  for (const pattern of patterns) {
    const match = errorText.match(pattern);
    if (!match?.[1]) continue;
    const parsed = Number(match[1].replaceAll(",", ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return null;
}

function nextRetryTokenCap(fileId: string, errorText: string): number {
  const previousCap =
    adaptiveTokenCapByFile.get(fileId) || DEFAULT_MAX_TOKENS_PER_BATCH;

  const explicitLimit = parseLimitTokens(errorText);
  const limitedCap = explicitLimit
    ? Math.floor(explicitLimit * TOKEN_BACKOFF_FACTOR)
    : Math.floor(previousCap * TOKEN_BACKOFF_FACTOR);

  return Math.max(MIN_RETRY_BATCH_TOKENS, limitedCap);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function extractHeader(payloadText: string, field: "From" | "To" | "Subject") {
  const match = payloadText.match(new RegExp(`^${field}:\\s*(.*)$`, "im"));
  return (match?.[1] || "").toLowerCase();
}

function payloadToText(payload: AiPayload): string {
  if (payload.text) return payload.text;

  const first = payload.first_email;
  const second = payload.second_email;
  const rest = payload.rest_of_chain?.text || "";

  return [
    first
      ? `From: ${first.from || ""}\nTo: ${first.to || ""}\nSubject: ${first.subject || ""}\n\n${first.body || ""}`
      : "",
    second
      ? `From: ${second.from || ""}\nTo: ${second.to || ""}\nSubject: ${second.subject || ""}\n\n${second.body || ""}`
      : "",
    rest,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readPayload(jsonFolder: string, emailHash: string): AiPayload | null {
  const jsonPath = path.join(jsonFolder, `${emailHash}.json`);
  if (!fs.existsSync(jsonPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as AiPayload;
  } catch (_err) {
    return null;
  }
}

function moveEmailToBucket(
  emailHash: string,
  bucket: "selected" | "discarded",
  folders: {
    rawEmails: string;
    selected: string;
    discarded: string;
  },
) {
  const filename = `${emailHash}.eml`;
  const rawPath = path.join(folders.rawEmails, filename);
  const selectedPath = path.join(folders.selected, filename);
  const discardedPath = path.join(folders.discarded, filename);
  const targetPath = bucket === "selected" ? selectedPath : discardedPath;
  const otherPath = bucket === "selected" ? discardedPath : selectedPath;

  if (fs.existsSync(otherPath)) fs.rmSync(otherPath, { force: true });

  if (fs.existsSync(rawPath)) {
    // Stage ownership is exclusive: selected/discarded contains the one
    // canonical EML, rather than a second copy beside raw-emails.
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
    fs.renameSync(rawPath, targetPath);
    return;
  }

  const sameBucketPath = bucket === "selected" ? selectedPath : discardedPath;
  if (fs.existsSync(sameBucketPath)) return;
}

function hasStrongSubjectSignal(
  payloadText: string,
  criteria: SubjectCriteria,
): boolean {
  const normalized = payloadText.toLowerCase();
  const from = extractHeader(payloadText, "From");
  const to = extractHeader(payloadText, "To");
  const subject = extractHeader(payloadText, "Subject");
  const headerText = `${from} ${to} ${subject}`;
  const bodyText = normalized.split(/\n\n/).slice(1).join("\n\n") || normalized;

  const email = (criteria.email || "").trim().toLowerCase();
  if (email) {
    const emailPattern = new RegExp(`\\b${escapeRegExp(email)}\\b`, "i");
    if (emailPattern.test(from) || emailPattern.test(to)) return true;
  }

  const personalEmail = (criteria.personalEmail || "").trim().toLowerCase();
  if (personalEmail) {
    const personalPattern = new RegExp(
      `\\b${escapeRegExp(personalEmail)}\\b`,
      "i",
    );
    if (personalPattern.test(from) || personalPattern.test(to)) return true;
  }

  const names = [criteria.name || "", ...(criteria.aliases || [])]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

  for (const name of names) {
    const tokenPattern = new RegExp(
      `\\b${escapeRegExp(name).replace(/\\\s+/g, "\\\\s+")}\\b`,
      "ig",
    );

    if (tokenPattern.test(headerText)) return true;

    const bodyMentions = countMatches(bodyText, tokenPattern);
    if (bodyMentions >= 2) return true;

    const forwardedContext =
      /(forwarded message|original message|from:|to:)/i.test(bodyText) &&
      bodyMentions >= 1;
    if (forwardedContext) return true;
  }

  return false;
}

async function runDiscardSecondPass(
  payload: AiPayload,
  criteria: SubjectCriteria,
): Promise<{ decision: "keep" | "discard"; reason: string }> {
  const attachmentCount =
    payload.meta?.attachment_count ?? payload.attachments?.length ?? 0;

  if (attachmentCount === 0) {
    return { decision: "discard", reason: "No attachments for second pass." };
  }

  const systemPrompt = `You are a strict DSAR reviewer for discarded emails.
Decide if this discarded email should be KEPT ONLY for attachment review.

Rules:
- Keep only if attachment metadata strongly suggests relevance to the subject.
- Prefer keep when attached emails/documents may contain subject data.
- If uncertain, return discard.

Return JSON only: {"decision":"keep"|"discard","reason":"brief"}`;

  const response = await (await getOpenAi()).chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.0,
    max_completion_tokens: 80,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          target: {
            name: criteria.name || "",
            email: criteria.email || "",
            aliases: criteria.aliases || [],
          },
          payload,
        }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() || "";
  const clean = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(clean) as {
      decision?: string;
      reason?: string;
    };
    return {
      decision: parsed.decision === "keep" ? "keep" : "discard",
      reason: parsed.reason || "Second-pass review completed.",
    };
  } catch (_err) {
    return { decision: "discard", reason: "Invalid second-pass AI output." };
  }
}

async function queuePdfWorker(fileId: string): Promise<void> {
  // Queue render immediately after AI completion so the pipeline continues even
  // when the UI is not actively orchestrating the case.
  await prisma.processedFile.update({
    where: { id: fileId },
    data: {
      pdf_status: "pending",
      pdf_duration_ms: 0,
      pdf_total: 0,
      pdf_processed: 0,
    },
  });

  await enqueueFilePhase({ fileId, phase: "render" });
}

function openAiCompletedAt(batch: OpenAI.Batches.Batch): Date | undefined {
  return typeof batch.completed_at === "number"
    ? new Date(batch.completed_at * 1_000)
    : undefined;
}

/**
 * AI is parallel, so its useful elapsed time is the wall-clock span from the
 * first upload to OpenAI's final completion event. Local output download or a
 * restarted poller must not inflate this metric.
 */
async function completedAiElapsedMs(
  coordinatorId: string,
  fallbackMs: number,
): Promise<number> {
  const timings = await prisma.aiBatchRun.aggregate({
    where: { coordinator_id: coordinatorId },
    _min: { submitted_at: true },
    _max: { openai_completed_at: true },
  });
  const firstSubmitted = timings._min.submitted_at;
  const lastCompleted = timings._max.openai_completed_at;
  if (!firstSubmitted || !lastCompleted) return fallbackMs;
  return Math.max(0, lastCompleted.getTime() - firstSubmitted.getTime());
}

async function pollSingleBatchStatus(
  fileId: string,
  batchRunId: string,
  batchId: string,
) {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: {
      filepath: true,
      subject_name: true,
      subject_email: true,
      subject_personal_email: true,
      subject_aliases: true,
      ai_started_at: true,
    },
  });

  if (!row?.filepath) return "no_batch";
  const filepath = row.filepath;
  const aiStartedAtMs =
    typeof row.ai_started_at === "bigint" ? Number(row.ai_started_at) : null;

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  const extractedPath =
    process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

  const targetFolder = getPstWorkFolder({
    fileId,
    filepath,
    stagingPath,
    extractedPath,
  });
  const uniqueEmailsFolder = path.join(targetFolder, ".unique-emails");
  const jsonFolder = path.join(uniqueEmailsFolder, "json-files");
  const rawEmailsFolder = path.join(uniqueEmailsFolder, "raw-emails");
  const selectedFolder = path.join(uniqueEmailsFolder, "selected");
  const discardedFolder = path.join(uniqueEmailsFolder, "discarded");

  fs.mkdirSync(selectedFolder, { recursive: true });
  fs.mkdirSync(discardedFolder, { recursive: true });

  console.log(`[Batch Worker] Checking status of batch: ${batchId}...`);
  const batch = await (await getOpenAi()).batches.retrieve(batchId);
  console.log(`[Batch Worker] Status returned from OpenAI: ${batch.status}`);

  if (batch.status === "completed") {
    await prisma.aiBatchRun.update({
      where: { id: batchRunId },
      data: {
        status: "processing",
        openai_completed_at: openAiCompletedAt(batch),
      },
    });
    // 🔥 NEW SAFETY CHECK: Catch silent OpenAI validation failures
    if (!batch.output_file_id) {
      console.error(
        `[Batch Worker] ERROR: Batch ${batch.id} completed but provided NO output_file_id!`,
      );
      if (batch.error_file_id) {
        try {
          const errRes = await (await getOpenAi()).files.content(
            batch.error_file_id,
          );
          const errText = await errRes.text();
          console.error(`[Batch Worker] OpenAI Error Log:\n`, errText);
        } catch (e) {
          console.error("Could not download error file", e);
        }
      }
      await prisma.$transaction([
        prisma.email.updateMany({
          where: { ai_batch_run_id: batchRunId, ai_decision: null },
          data: { ai_batch_run_id: null },
        }),
        prisma.aiBatchRun.update({
          where: { id: batchRunId },
          data: {
            status: "retryable",
            error: "Batch completed without an output file.",
            completed_at: new Date(),
          },
        }),
      ]);
      await fillAiBatchSlots(fileId, criteriaFromRow(row));
      return batch.status;
    }

    await prisma.processedFile.update({
      where: { id: fileId },
      data: { ai_status: "processing" },
    });

    console.log(
      `[Batch Worker] Downloading results from file ${batch.output_file_id}...`,
    );
    const fileResponse = await (await getOpenAi()).files.content(
      batch.output_file_id,
    );
    const content = await fileResponse.text();
    const lines = content.trim().split("\n");

    let keepCount = 0;
    let discardCount = 0;
    const auditStats = {
      firstPassKeep: 0,
      firstPassDiscard: 0,
      invalidOutput: 0,
      weakSignalOverrides: 0,
      secondPassRequested: 0,
      secondPassExecuted: 0,
      secondPassRescued: 0,
    };

    const payloadCache = new Map<string, AiPayload | null>();
    const subjectCriteria: SubjectCriteria = {
      name: row.subject_name || "",
      email: row.subject_email || "",
      personalEmail: row.subject_personal_email || undefined,
      aliases: row.subject_aliases
        ? row.subject_aliases
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        : [],
    };

    const pendingUpdates: Array<{
      emailHash: string;
      decision: "keep" | "discard";
      reason: string;
    }> = [];
    const selectedHashes: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const responseObj = JSON.parse(line);
      const emailHash = responseObj.custom_id;

      const bodyContent = responseObj.response?.body;
      if (!bodyContent) continue;

      const choice = bodyContent.choices[0];
      const rawJson = choice.message.content.trim();
      const cleanJson = rawJson
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "");

      let decisionData: {
        decision?: string;
        reason?: string;
        needs_second_pass?: boolean;
      };

      try {
        decisionData = JSON.parse(cleanJson);
      } catch (_err) {
        auditStats.invalidOutput++;
        decisionData = {
          decision: "discard",
          reason: "Invalid AI output format.",
          needs_second_pass: false,
        };
      }

      let decision: "keep" | "discard" =
        decisionData.decision === "keep" ? "keep" : "discard";
      let reason = decisionData.reason || "Audited via GPT.";

      if (decision === "keep") auditStats.firstPassKeep++;
      else auditStats.firstPassDiscard++;

      if (decisionData.needs_second_pass === true) {
        auditStats.secondPassRequested++;
      }

      let payload = payloadCache.get(emailHash);
      if (payload === undefined) {
        payload = readPayload(jsonFolder, emailHash);
        payloadCache.set(emailHash, payload);
      }

      const payloadText = payload ? payloadToText(payload) : "";

      if (decision === "keep") {
        if (
          !payloadText ||
          !hasStrongSubjectSignal(payloadText, subjectCriteria)
        ) {
          decision = "discard";
          reason = "System Override: weak or ambiguous subject signal.";
          auditStats.weakSignalOverrides++;
        }
      }

      if (
        decision === "discard" &&
        decisionData.needs_second_pass === true &&
        payload
      ) {
        auditStats.secondPassExecuted++;
        const secondPass = await runDiscardSecondPass(payload, subjectCriteria);
        if (secondPass.decision === "keep") {
          decision = "keep";
          reason = `Second Pass: ${secondPass.reason}`;
          auditStats.secondPassRescued++;
        }
      }

      pendingUpdates.push({ emailHash, decision, reason });

      moveEmailToBucket(
        emailHash,
        decision === "keep" ? "selected" : "discarded",
        {
          rawEmails: rawEmailsFolder,
          selected: selectedFolder,
          discarded: discardedFolder,
        },
      );

      if (decision === "keep") {
        keepCount++;
        selectedHashes.push(emailHash);
      } else {
        discardCount++;
      }
    }

    await prisma.$transaction([
      ...pendingUpdates.map((item) =>
        prisma.email.updateMany({
          where: { email_hash: item.emailHash, ai_batch_run_id: batchRunId },
          data: {
            ai_decision: item.decision,
            ai_reason: item.reason,
            ai_batch_run_id: null,
          },
        }),
      ),
      // A completed Batch may include failed request lines.  Successful lines
      // above have durable decisions; release only the unresolved claimed lines
      // so the next slot retries precisely those custom IDs.
      prisma.email.updateMany({
        where: { ai_batch_run_id: batchRunId, ai_decision: null },
        data: { ai_batch_run_id: null },
      }),
      prisma.aiBatchRun.update({
        where: { id: batchRunId },
        data: { status: "completed", completed_at: new Date() },
      }),
    ]);

    // Once a keep decision is durable, the EML has been moved to selected/ and
    // no later AI step needs its JSON payload. Remove it immediately instead of
    // retaining a second representation until the end of the whole case.
    for (const emailHash of selectedHashes) {
      try {
        fs.rmSync(path.join(jsonFolder, `${emailHash}.json`), { force: true });
      } catch (error) {
        console.warn(
          `[Batch Worker] Could not reclaim JSON payload for ${emailHash}:`,
          error,
        );
      }
    }

    // Selected/discarded folders are now the canonical AI outputs.

    // One OpenAI batch (chunk) has been fully processed. Advance the batch
    // counter used for UI progress; keep the total >= done in case the initial
    // estimate was too low.
    const casePstIds = await getCasePstFileIds(fileId);
    const [approved, discarded] = await Promise.all([
      prisma.email.count({
        where: {
          file_id: { in: casePstIds },
          is_duplicate: 0,
          ai_decision: "keep",
        },
      }),
      prisma.email.count({
        where: {
          file_id: { in: casePstIds },
          is_duplicate: 0,
          ai_decision: "discard",
        },
      }),
    ]);
    await prisma.$transaction(async (tx) => {
      const updated = await tx.processedFile.update({
        where: { id: fileId },
        data: {
          // These are case-level summaries. Recalculate from durable email
          // rows so polling/retry delivery can never double-count a Batch.
          ai_approved_count: approved,
          ai_discarded_count: discarded,
          ai_batches_done: { increment: 1 },
        },
        select: { ai_batches_done: true, ai_batches_total: true },
      });
      await tx.processedFile.updateMany({
        where: { id: { in: casePstIds.filter((id) => id !== fileId) } },
        data: { ai_approved_count: 0, ai_discarded_count: 0 },
      });
      if (updated.ai_batches_total < updated.ai_batches_done) {
        await tx.processedFile.update({
          where: { id: fileId },
          data: { ai_batches_total: updated.ai_batches_done },
        });
      }
    });

    console.log(
      `[AI Audit] file=${fileId} first_pass_keep=${auditStats.firstPassKeep} first_pass_discard=${auditStats.firstPassDiscard} weak_signal_overrides=${auditStats.weakSignalOverrides} second_pass_requested=${auditStats.secondPassRequested} second_pass_executed=${auditStats.secondPassExecuted} second_pass_rescued=${auditStats.secondPassRescued} invalid_outputs=${auditStats.invalidOutput} final_keep=${keepCount} final_discard=${discardCount}`,
    );

    const remainingCount = await prisma.email.count({
      where: {
        file_id: { in: casePstIds },
        is_duplicate: 0,
        ai_decision: null,
      },
    });

    const activeBatchCount = await prisma.aiBatchRun.count({
      where: {
        coordinator_id: fileId,
        status: { in: ["claiming", "submitted", "processing"] },
      },
    });

    if (remainingCount > 0) {
      console.log(
        `[Batch Worker] Chunk complete. ${remainingCount} items remaining. Generating next chunk immediately...`,
      );

      const adaptiveCap = adaptiveTokenCapByFile.get(fileId);
      try {
        await fillAiBatchSlots(
          fileId,
          criteriaFromRow(row),
          adaptiveCap ? { maxTokensPerBatch: adaptiveCap } : undefined,
        );
      } catch (err) {
        console.error(
          `[Batch Worker] Fatal error generating next chunk for ${fileId}:`,
          err,
        );
        await markCaseAiFailed(
          fileId,
          typeof aiStartedAtMs === "number"
            ? Math.max(0, Date.now() - aiStartedAtMs)
            : 0,
        );
      }
    } else if (activeBatchCount === 0) {
      console.log(
        `[Batch Worker] All AI chunks completed successfully for case (coordinator ${fileId}).`,
      );

      await markCaseAiCompleted(
        fileId,
        await completedAiElapsedMs(
          fileId,
          typeof aiStartedAtMs === "number"
            ? Math.max(0, Date.now() - aiStartedAtMs)
            : 0,
        ),
      );

      adaptiveTokenCapByFile.delete(fileId);

      // Render is case-level (all PST files in a request share the selected/
      // folder). The case is now settled, so kick off a single render pass.
      if (await isCaseAiSettled(fileId)) {
        await queuePdfWorker(fileId);
      } else {
        console.log(
          `[Batch Worker] AI done for ${fileId}; waiting for sibling PST files before rendering the case.`,
        );
      }
    }
  } else if (isTokenLimitBatchFailure(batch)) {
    const errorText = getBatchErrorText(batch);
    const retryCap = nextRetryTokenCap(fileId, errorText);
    adaptiveTokenCapByFile.set(fileId, retryCap);

    console.error(
      `[Batch Worker] Batch ${batch.id} failed due to token limits. Retrying with reduced chunk cap ${retryCap} tokens for file ${fileId}.`,
    );

    await prisma.$transaction([
      prisma.email.updateMany({
        where: { ai_batch_run_id: batchRunId, ai_decision: null },
        data: { ai_batch_run_id: null },
      }),
      prisma.aiBatchRun.update({
        where: { id: batchRunId },
        data: {
          status: "retryable",
          error: errorText.slice(0, 1000),
          completed_at: new Date(),
        },
      }),
    ]);

    try {
      await fillAiBatchSlots(fileId, criteriaFromRow(row), {
        maxTokensPerBatch: retryCap,
      });
      return "retrying_token_limited";
    } catch (err) {
      console.error(
        `[Batch Worker] Failed to regenerate token-limited batch for ${fileId}:`,
        err,
      );
      adaptiveTokenCapByFile.delete(fileId);
      await markCaseAiFailed(
        fileId,
        typeof aiStartedAtMs === "number"
          ? Math.max(0, Date.now() - aiStartedAtMs)
          : 0,
      );
      return "failed";
    }
  } else if (isExpiredBatchFailure(batch)) {
    console.error(
      `[Batch Worker] Batch ${batch.id} expired. Re-uploading a fresh batch for file ${fileId}...`,
    );

    await prisma.$transaction([
      prisma.email.updateMany({
        where: { ai_batch_run_id: batchRunId, ai_decision: null },
        data: { ai_batch_run_id: null },
      }),
      prisma.aiBatchRun.update({
        where: { id: batchRunId },
        data: {
          status: "retryable",
          error: "Batch expired.",
          completed_at: new Date(),
        },
      }),
    ]);

    try {
      await fillAiBatchSlots(
        fileId,
        criteriaFromRow(row),
        adaptiveTokenCapByFile.has(fileId)
          ? { maxTokensPerBatch: adaptiveTokenCapByFile.get(fileId) }
          : undefined,
      );
      return "retrying_expired";
    } catch (err) {
      console.error(
        `[Batch Worker] Failed to regenerate expired batch for ${fileId}:`,
        err,
      );
      adaptiveTokenCapByFile.delete(fileId);
      await markCaseAiFailed(
        fileId,
        typeof aiStartedAtMs === "number"
          ? Math.max(0, Date.now() - aiStartedAtMs)
          : 0,
      );
      return "failed";
    }
  } else if (batch.status === "failed" || batch.status === "cancelled") {
    console.error(
      `[Batch Worker] OpenAI batch execution failed/cancelled. Status: ${batch.status}`,
    );
    adaptiveTokenCapByFile.delete(fileId);
    await prisma.$transaction([
      prisma.email.updateMany({
        where: { ai_batch_run_id: batchRunId, ai_decision: null },
        data: { ai_batch_run_id: null },
      }),
      prisma.aiBatchRun.update({
        where: { id: batchRunId },
        data: {
          status: "retryable",
          error: getBatchErrorText(batch).slice(0, 1000) || batch.status,
          completed_at: new Date(),
        },
      }),
    ]);
    await fillAiBatchSlots(fileId, criteriaFromRow(row));
  }

  return batch.status;
}

/** Poll every durable Batch submitted for this case coordinator.  `batch_id`
 * on processed_files is retained only for compatibility; it cannot represent
 * multiple in-flight batches and is never used for ownership. */
export async function pollBatchStatus(fileId: string) {
  const runs = await prisma.aiBatchRun.findMany({
    where: {
      coordinator_id: fileId,
      status: "submitted",
      openai_batch_id: { not: null },
    },
    select: { id: true, openai_batch_id: true },
  });
  if (runs.length === 0) return "no_batch";

  const statuses = await Promise.all(
    runs.map((run) =>
      pollSingleBatchStatus(fileId, run.id, run.openai_batch_id as string),
    ),
  );
  return statuses.join(",");
}
