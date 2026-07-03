import { NextResponse } from "next/server";
import { DEFAULT_MAX_TOKENS_PER_BATCH, generateBatchFile } from "@/lib/ai";
import { ensureBatchPollerRunning } from "@/lib/batch-scheduler";
import { getCasePstFileIds } from "@/lib/case-utils";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // Cast the parsed request body to eliminate implicit 'any' warnings
    const { fileId, subjectCriteria } = (await request.json()) as {
      fileId: string;
      subjectCriteria?: { name: string; email: string; aliases: string[] };
    };

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    const row = db
      .prepare(
        "SELECT status, subject_name, subject_email, subject_aliases, estimated_tokens, unique_emails FROM processed_files WHERE id = ?",
      )
      .get(fileId) as
      | {
          status: string;
          subject_name?: string;
          subject_email?: string;
          subject_aliases?: string;
          estimated_tokens?: number;
          unique_emails?: number;
        }
      | undefined;

    if (!row || row.status !== "completed") {
      return NextResponse.json(
        {
          success: false,
          error: "File must be extracted before AI batch generation.",
        },
        { status: 400 },
      );
    }

    // 1. Resolve subject criteria from request or fallback to saved database config
    let finalCriteria = subjectCriteria;
    if (!finalCriteria) {
      if (row.subject_name && row.subject_email) {
        finalCriteria = {
          name: row.subject_name,
          email: row.subject_email,
          aliases: row.subject_aliases
            ? row.subject_aliases
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        };
      } else {
        return NextResponse.json(
          { success: false, error: "Missing subject criteria configuration." },
          { status: 400 },
        );
      }
    }

    // 🚨 Instantly lock the file status to 'processing'
    // This tells the React Master Orchestrator to stop and wait before firing the next file.
    // AI is case-level: this `fileId` is the coordinator row and the batch total
    // is estimated across EVERY PST file in the request. Per-request fixed
    // overhead (system prompt + schema + msg overhead) is added on top of the
    // raw payload token estimate; the batch worker self-corrects if exceeded.
    const casePstIds = getCasePstFileIds(fileId);
    const caseTotals = db
      .prepare(
        `SELECT COALESCE(SUM(estimated_tokens), 0) AS et,
                COALESCE(SUM(unique_emails), 0) AS ue
         FROM processed_files
         WHERE id IN (${casePstIds.map(() => "?").join(",")})`,
      )
      .get(...casePstIds) as { et: number; ue: number };

    const PER_REQUEST_OVERHEAD_TOKENS = 650;
    const estimatedRequestTokens =
      caseTotals.et + caseTotals.ue * PER_REQUEST_OVERHEAD_TOKENS;
    const estimatedBatches = Math.max(
      1,
      Math.ceil(estimatedRequestTokens / DEFAULT_MAX_TOKENS_PER_BATCH),
    );
    db.prepare(
      "UPDATE processed_files SET ai_status = 'processing', ai_started_at = ?, ai_duration_ms = 0, ai_batches_total = ?, ai_batches_done = 0 WHERE id = ?",
    ).run(Date.now(), estimatedBatches, fileId);

    // AI phase has started — start the in-server batch poller. It self-stops
    // once no AI/render work remains, so no external cron process is needed.
    ensureBatchPollerRunning();

    // Trigger the Batch generation process safely in the background
    setTimeout(() => {
      generateBatchFile(fileId, finalCriteria)
        .then(() => {})
        .catch((err) => {
          console.error(`Batch generation crashed for file ${fileId}:`, err);
          db.prepare(
            "UPDATE processed_files SET ai_status = 'failed', ai_started_at = NULL WHERE id = ?",
          ).run(fileId);
        });
    }, 50);

    return NextResponse.json(
      { success: true, message: "AI Batch job generation initiated" },
      { status: 202 },
    );
  } catch (error) {
    console.error("API route /api/filter encountered an error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
