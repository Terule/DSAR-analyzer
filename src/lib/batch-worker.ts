import fs from "node:fs";
import path from "node:path";
import { emailAiTestOverride, fillAiBatchSlots } from "./ai";
import {
  BEDROCK_BATCH_PREFIX,
  CONVERSE_MODEL,
  REREVIEW_DEFAULT_MIN_P_KEEP,
  REREVIEW_DEFAULT_SAMPLE_PERCENT,
} from "./bedrock/config";
import {
  awsBedrockDeps,
  removeBedrockArtifacts,
} from "./bedrock/files-ai-client";
import { shouldRereview } from "./bedrock/rereview-gate";
import {
  getCasePstFileIds,
  isCaseAiSettled,
  markCaseAiFailed,
} from "./case-utils";
import { enqueueFilePhase } from "./control-plane/pipeline";
import { applyConfidentiality } from "./email-audit";
import { configuredFilesAiClient } from "./files-ai-provider";
import { startMailScreen } from "./mail-screen";
import { getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";
import { getPstWorkFolder } from "./pst-artifacts";

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

/** What this module reads of a batch: Bedrock's job state mapped onto a few fields. */
interface BatchState {
  id: string;
  status: string;
  output_file_id: string | null;
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

export function hasStrongSubjectSignal(
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

  const userContent = JSON.stringify({
    target: {
      name: criteria.name || "",
      email: criteria.email || "",
      aliases: criteria.aliases || [],
    },
    payload,
  });

  // Haiku 5.5 through Converse, answering with a forced tool.
  const converse = emailAiTestOverride.converse ?? awsBedrockDeps().converse;
  let clean: string;
  try {
    const input = await converse(
      {
        customId: "second-pass",
        system: systemPrompt,
        user: userContent,
        toolName: "second_pass_decision",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["decision", "reason"],
          properties: {
            decision: { type: "string", enum: ["keep", "discard"] },
            reason: { type: "string", maxLength: 200 },
          },
        },
        maxTokens: 300,
      },
      CONVERSE_MODEL,
    );
    clean = input === undefined ? "" : JSON.stringify(input);
  } catch (_err) {
    return { decision: "discard", reason: "Second-pass call failed." };
  }

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

export async function queuePdfWorker(fileId: string): Promise<void> {
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

/**
 * AI is parallel, so its useful elapsed time is the wall-clock span from the
 * first upload to the job's final completion. Local output download or a
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

/** Emails of these PST rows whose discard still waits for, or is getting, a second review. */
export async function emailRereviewPending(
  casePstIds: string[],
): Promise<boolean> {
  const waiting = await prisma.email.findFirst({
    where: { file_id: { in: casePstIds }, rereview_status: { not: null } },
    select: { email_hash: true },
  });
  return !!waiting;
}

/**
 * The email audit of a case is fully decided (every chunk applied, every second
 * review settled). Screens attachments and client bodies, then releases Render.
 * Called by the poller after the last chunk and by the second-review job after
 * its last verdict, whichever comes last.
 */
export async function completeEmailAudit(fileId: string): Promise<void> {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { ai_started_at: true },
  });
  const aiStartedAtMs =
    typeof row?.ai_started_at === "bigint" ? Number(row.ai_started_at) : null;
  console.log(
    `[Batch Worker] All AI chunks completed successfully for case (coordinator ${fileId}).`,
  );

  // The audit is done. Before Render, what it never read (attachments, and
  // client email bodies) is screened for confidential content; the case
  // completes its AI phase once that settles.
  const screening = await startMailScreen(
    fileId,
    await completedAiElapsedMs(
      fileId,
      typeof aiStartedAtMs === "number"
        ? Math.max(0, Date.now() - aiStartedAtMs)
        : 0,
    ),
  );

  if (screening === "screening") {
    console.log(
      `[Batch Worker] Email audit done for ${fileId}; screening attachments before Render.`,
    );
  } else if (await isCaseAiSettled(fileId)) {
    // Render is case-level (all PST files in a request share the selected/
    // folder). The case is now settled, so kick off a single render pass.
    await queuePdfWorker(fileId);
  } else {
    console.log(
      `[Batch Worker] AI done for ${fileId}; waiting for sibling PST files before rendering the case.`,
    );
  }
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
  // The run is read through the Files AI client seam.
  const client =
    emailAiTestOverride.client ?? (await configuredFilesAiClient());
  const state = await client.retrieveBatch(batchId);
  const batch: BatchState = {
    id: batchId,
    status: state.status,
    output_file_id: state.outputFileId ?? null,
  };
  if (["failed", "expired", "cancelled"].includes(state.status)) {
    removeBedrockArtifacts(batchId);
  }
  console.log(`[Batch Worker] Status returned from Bedrock: ${batch.status}`);

  if (batch.status === "completed") {
    await prisma.aiBatchRun.update({
      where: { id: batchRunId },
      data: {
        status: "processing",
        openai_completed_at: new Date(),
      },
    });
    // A completed job without output cannot be read: release its emails for retry.
    if (!batch.output_file_id) {
      console.error(
        `[Batch Worker] ERROR: Batch ${batch.id} completed but provided NO output!`,
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
    const content = await client.readFile(batch.output_file_id);
    const lines = content.trim().split("\n");

    let keepCount = 0;
    let discardCount = 0;
    const auditStats = {
      firstPassKeep: 0,
      firstPassDiscard: 0,
      invalidOutput: 0,
      rereviewQueued: 0,
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
      pKeep: number | null;
      rereview: boolean;
    }> = [];
    // Haiku 4.5 (Batch) discards that show doubt get a second opinion from
    // Haiku 5.5; Converse runs are already Haiku 5.5.
    const settings = await getAiBatchSettings();
    const rereviewConfig = {
      minPKeep: settings.rereviewMinPKeep ?? REREVIEW_DEFAULT_MIN_P_KEEP,
      sampleRate:
        (settings.rereviewSamplePercent ?? REREVIEW_DEFAULT_SAMPLE_PERCENT) /
        100,
    };
    const gateRereview = batchId.startsWith(BEDROCK_BATCH_PREFIX);
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
        sensitivity?: string;
        confidence?: number;
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

      // Confidential content is never delivered, whatever else the audit
      // concluded, and a confidential email is not rescued by a second pass.
      const audited = applyConfidentiality({
        decision: decisionData.decision === "keep" ? "keep" : "discard",
        reason: decisionData.reason || "Audited via GPT.",
        needsSecondPass: decisionData.needs_second_pass === true,
        sensitivity: decisionData.sensitivity,
      });
      let decision: "keep" | "discard" = audited.decision;
      let reason = audited.reason;
      decisionData.needs_second_pass = audited.needsSecondPass;

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

      // The audit's own judgement stands: the weak-signal override that used to
      // flip a keep to a discard here contradicted the prompt rules (an email
      // about the subject with only a first name is kept).
      const pKeep =
        typeof decisionData.confidence === "number" &&
        Number.isFinite(decisionData.confidence)
          ? Math.min(100, Math.max(0, Math.round(decisionData.confidence)))
          : null;
      const rereview =
        gateRereview &&
        decision === "discard" &&
        shouldRereview(
          {
            id: emailHash,
            pKeep,
            sensitivity: decisionData.sensitivity ?? null,
            subjectInvolved:
              !!payloadText &&
              hasStrongSubjectSignal(payloadText, subjectCriteria),
          },
          rereviewConfig,
        );
      if (rereview) auditStats.rereviewQueued++;

      pendingUpdates.push({ emailHash, decision, reason, pKeep, rereview });

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
            ai_p_keep: item.pKeep,
            ...(item.rereview
              ? {
                  rereview_status: "pending",
                  rereview_queued_at: new Date(),
                  rereview_coordinator_id: fileId,
                }
              : {}),
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

    // The decisions are durable: the run's local Bedrock files are no longer needed.
    removeBedrockArtifacts(batchId);

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

    // One batch (chunk) has been fully processed. Advance the batch
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
      `[AI Audit] file=${fileId} first_pass_keep=${auditStats.firstPassKeep} first_pass_discard=${auditStats.firstPassDiscard} rereview_queued=${auditStats.rereviewQueued} second_pass_requested=${auditStats.secondPassRequested} second_pass_executed=${auditStats.secondPassExecuted} second_pass_rescued=${auditStats.secondPassRescued} invalid_outputs=${auditStats.invalidOutput} final_keep=${keepCount} final_discard=${discardCount}`,
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

      try {
        await fillAiBatchSlots(fileId, criteriaFromRow(row));
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
      // Discards waiting for their second opinion hold the phase: Render reads
      // selected/, which the review may still change.
      if (await emailRereviewPending(casePstIds)) {
        console.log(
          `[Batch Worker] Email audit chunks done for ${fileId}; waiting for the second review.`,
        );
      } else {
        await completeEmailAudit(fileId);
      }
    }
  } else if (
    batch.status === "failed" ||
    batch.status === "cancelled" ||
    batch.status === "expired"
  ) {
    console.error(
      `[Batch Worker] Batch ${batch.id} did not complete. Status: ${batch.status}`,
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
          error: batch.status,
          completed_at: new Date(),
        },
      }),
    ]);
    // Resubmit what did not yield a decision; a failure to do so fails the case.
    try {
      await fillAiBatchSlots(fileId, criteriaFromRow(row));
    } catch (err) {
      console.error(
        `[Batch Worker] Failed to regenerate batch for ${fileId}:`,
        err,
      );
      await markCaseAiFailed(
        fileId,
        typeof aiStartedAtMs === "number"
          ? Math.max(0, Date.now() - aiStartedAtMs)
          : 0,
      );
      return "failed";
    }
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
