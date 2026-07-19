import { NextResponse } from "next/server";
import { DEFAULT_MAX_TOKENS_PER_BATCH, generateBatchFile } from "@/lib/ai";
import { ensureBatchPollerRunning } from "@/lib/batch-scheduler";
import { getCasePstFileIds } from "@/lib/case-utils";
import {
  enqueueFilePhase,
  isControlPlanePipelineEnabled,
} from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // Cast the parsed request body to eliminate implicit 'any' warnings
    const { fileId, subjectCriteria } = (await request.json()) as {
      fileId: string;
      subjectCriteria?: {
        name: string;
        email: string;
        personalEmail?: string;
        aliases: string[];
      };
    };

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    const row = await prisma.processedFile.findUnique({
      where: { id: fileId },
      select: {
        status: true,
        subject_name: true,
        subject_email: true,
        subject_personal_email: true,
        subject_aliases: true,
        estimated_tokens: true,
        unique_emails: true,
      },
    });

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
          personalEmail: row.subject_personal_email || undefined,
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

    // Persist personal email separately (ai.ts only saves name/email/aliases).
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { subject_personal_email: finalCriteria.personalEmail ?? null },
    });

    // 🚨 Instantly lock the file status to 'processing'
    // This tells the React Master Orchestrator to stop and wait before firing the next file.
    // AI is case-level: this `fileId` is the coordinator row and the batch total
    // is estimated across EVERY PST file in the request. Per-request fixed
    // overhead (system prompt + schema + msg overhead) is added on top of the
    // raw payload token estimate; the batch worker self-corrects if exceeded.
    const casePstIds = await getCasePstFileIds(fileId);
    const caseTotals = await prisma.processedFile.aggregate({
      where: { id: { in: casePstIds } },
      _sum: { estimated_tokens: true, unique_emails: true },
    });

    const PER_REQUEST_OVERHEAD_TOKENS = 650;
    const estimatedRequestTokens =
      (caseTotals._sum.estimated_tokens ?? 0) +
      (caseTotals._sum.unique_emails ?? 0) * PER_REQUEST_OVERHEAD_TOKENS;
    const estimatedBatches = Math.max(
      1,
      Math.ceil(estimatedRequestTokens / DEFAULT_MAX_TOKENS_PER_BATCH),
    );
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        ai_status: "processing",
        ai_started_at: BigInt(Date.now()),
        ai_duration_ms: 0,
        ai_batches_total: estimatedBatches,
        ai_batches_done: 0,
      },
    });

    if (isControlPlanePipelineEnabled()) {
      await enqueueFilePhase({ fileId, phase: "ai" });
      return NextResponse.json(
        { success: true, message: "AI Batch job queued" },
        { status: 202 },
      );
    }

    // Legacy non-control-plane mode owns polling in the app process.
    ensureBatchPollerRunning();

    // Trigger the Batch generation process safely in the background
    setTimeout(() => {
      generateBatchFile(fileId, finalCriteria)
        .then(() => {})
        .catch(async (err) => {
          console.error(`Batch generation crashed for file ${fileId}:`, err);
          await prisma.processedFile.update({
            where: { id: fileId },
            data: { ai_status: "failed", ai_started_at: null },
          });
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
