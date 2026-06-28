import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { generateBatchFile } from "./ai";
import { db } from "./db";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  aliases?: string[];
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
    fs.copyFileSync(rawPath, targetPath);
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

  const response = await openai.chat.completions.create({
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

export async function pollBatchStatus(fileId: string) {
  // ⏱ Start Tracking Download & DB Processing Time
  const startTime = Date.now();

  const row = db
    .prepare(
      "SELECT filepath, batch_id, subject_name, subject_email, subject_aliases FROM processed_files WHERE id = ?",
    )
    .get(fileId) as
    | {
        filepath: string;
        batch_id: string;
        subject_name?: string;
        subject_email?: string;
        subject_aliases?: string;
      }
    | undefined;

  if (!row || !row.batch_id) return "no_batch";

  const stagingPath =
    process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
  const extractedPath =
    process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

  let relativeSystemPath = path.relative(stagingPath, row.filepath);
  if (
    relativeSystemPath.startsWith("..") ||
    path.isAbsolute(relativeSystemPath)
  ) {
    relativeSystemPath = fileId;
  }

  let cleanRelativePath = path.dirname(relativeSystemPath);
  if (cleanRelativePath === "." || cleanRelativePath === "") {
    cleanRelativePath = path.parse(relativeSystemPath).name;
  }

  const targetFolder = path.join(extractedPath, cleanRelativePath);
  const uniqueEmailsFolder = path.join(targetFolder, ".unique-emails");
  const jsonFolder = path.join(uniqueEmailsFolder, "json-files");
  const rawEmailsFolder = path.join(uniqueEmailsFolder, "raw-emails");
  const selectedFolder = path.join(uniqueEmailsFolder, "selected");
  const discardedFolder = path.join(uniqueEmailsFolder, "discarded");

  fs.mkdirSync(selectedFolder, { recursive: true });
  fs.mkdirSync(discardedFolder, { recursive: true });

  console.log(`[Batch Worker] Checking status of batch: ${row.batch_id}...`);
  const batch = await openai.batches.retrieve(row.batch_id);
  console.log(`[Batch Worker] Status returned from OpenAI: ${batch.status}`);

  if (batch.status === "completed") {
    // 🔥 NEW SAFETY CHECK: Catch silent OpenAI validation failures
    if (!batch.output_file_id) {
      console.error(
        `[Batch Worker] ERROR: Batch ${batch.id} completed but provided NO output_file_id!`,
      );
      if (batch.error_file_id) {
        try {
          const errRes = await openai.files.content(batch.error_file_id);
          const errText = await errRes.text();
          console.error(`[Batch Worker] OpenAI Error Log:\n`, errText);
        } catch (e) {
          console.error("Could not download error file", e);
        }
      }
      db.prepare(
        "UPDATE processed_files SET ai_status = 'failed' WHERE id = ?",
      ).run(fileId);
      return batch.status;
    }

    db.prepare(
      "UPDATE processed_files SET ai_status = 'processing' WHERE id = ?",
    ).run(fileId);

    console.log(
      `[Batch Worker] Downloading results from file ${batch.output_file_id}...`,
    );
    const fileResponse = await openai.files.content(batch.output_file_id);
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

    const keptHashes: string[] = [];
    const payloadCache = new Map<string, AiPayload | null>();
    const subjectCriteria: SubjectCriteria = {
      name: row.subject_name || "",
      email: row.subject_email || "",
      aliases: row.subject_aliases
        ? row.subject_aliases
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        : [],
    };
    const updateStmt = db.prepare(
      "UPDATE emails SET ai_decision = ?, ai_reason = ? WHERE email_hash = ? AND file_id = ?",
    );

    const pendingUpdates: Array<{
      emailHash: string;
      decision: "keep" | "discard";
      reason: string;
    }> = [];

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
        keptHashes.push(emailHash);
      } else {
        discardCount++;
      }
    }

    db.transaction(() => {
      for (const item of pendingUpdates) {
        updateStmt.run(item.decision, item.reason, item.emailHash, fileId);
      }
    })();

    // Selected/discarded folders are now the canonical AI outputs.

    db.prepare(`
      UPDATE processed_files
      SET ai_approved_count = ai_approved_count + ?,
          ai_discarded_count = ai_discarded_count + ?
      WHERE id = ?
    `).run(keepCount, discardCount, fileId);

    console.log(
      `[AI Audit] file=${fileId} first_pass_keep=${auditStats.firstPassKeep} first_pass_discard=${auditStats.firstPassDiscard} weak_signal_overrides=${auditStats.weakSignalOverrides} second_pass_requested=${auditStats.secondPassRequested} second_pass_executed=${auditStats.secondPassExecuted} second_pass_rescued=${auditStats.secondPassRescued} invalid_outputs=${auditStats.invalidOutput} final_keep=${keepCount} final_discard=${discardCount}`,
    );

    const remaining = db
      .prepare(
        "SELECT count(*) as c FROM emails WHERE file_id = ? AND is_duplicate = 0 AND ai_decision IS NULL",
      )
      .get(fileId) as { c: number };

    if (remaining.c > 0) {
      console.log(
        `[Batch Worker] Chunk complete. ${remaining.c} items remaining. Generating next chunk immediately...`,
      );

      // ⏱ Save Duration for this Chunk before generating next
      const durationMs = Date.now() - startTime;
      db.prepare(
        "UPDATE processed_files SET ai_status = 'processing', batch_id = NULL, ai_duration_ms = COALESCE(ai_duration_ms, 0) + ? WHERE id = ?",
      ).run(durationMs, fileId);

      // 🔥 FIRE THE NEXT CHUNK INSTANTLY 🔥
      generateBatchFile(fileId, {
        name: row.subject_name || "",
        email: row.subject_email || "",
        aliases: row.subject_aliases
          ? row.subject_aliases
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean)
          : [],
      }).catch((err) => {
        console.error(
          `[Batch Worker] Fatal error generating next chunk for ${fileId}:`,
          err,
        );
        db.prepare(
          "UPDATE processed_files SET ai_status = 'failed' WHERE id = ?",
        ).run(fileId);
      });
    } else {
      console.log(
        `[Batch Worker] All AI chunks completed successfully for file ${fileId}.`,
      );

      // ⏱ Save Final Duration
      const durationMs = Date.now() - startTime;
      db.prepare(
        "UPDATE processed_files SET ai_status = 'completed', batch_id = NULL, ai_duration_ms = COALESCE(ai_duration_ms, 0) + ? WHERE id = ?",
      ).run(durationMs, fileId);
    }
  } else if (
    batch.status === "failed" ||
    batch.status === "expired" ||
    batch.status === "cancelled"
  ) {
    console.error(
      `[Batch Worker] OpenAI batch execution failed/cancelled. Status: ${batch.status}`,
    );
    db.prepare(
      "UPDATE processed_files SET ai_status = 'failed' WHERE id = ?",
    ).run(fileId);
  }

  return batch.status;
}
