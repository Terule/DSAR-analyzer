import { NextResponse } from "next/server";
import { getCasePstFileIds } from "@/lib/case-utils";
import { enqueueFilePhase } from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Resume only the unfinished AI rows of a faulted request. Parse/Extract
 * artifacts and already persisted decisions remain untouched. */
export async function POST(request: Request) {
  try {
    const { fileId } = (await request.json()) as { fileId?: string };
    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "fileId is required." },
        { status: 400 },
      );
    }

    const caseIds = await getCasePstFileIds(fileId);
    const coordinatorId = [...caseIds].sort()[0];
    if (!coordinatorId) throw new Error("Could not determine AI coordinator.");

    const [rows, activeClaims, remaining] = await Promise.all([
      prisma.processedFile.findMany({
        where: { id: { in: caseIds } },
        select: { id: true, status: true, ai_status: true },
      }),
      prisma.aiBatchRun.count({
        where: {
          coordinator_id: coordinatorId,
          status: { in: ["claiming", "submitted", "processing"] },
        },
      }),
      prisma.email.count({
        where: {
          file_id: { in: caseIds },
          is_duplicate: 0,
          ai_decision: null,
        },
      }),
    ]);

    if (rows.some((row) => row.status !== "completed")) {
      return NextResponse.json(
        {
          success: false,
          error: "Every PST must finish extraction before AI can resume.",
        },
        { status: 409 },
      );
    }
    if (!rows.some((row) => row.ai_status === "failed")) {
      return NextResponse.json(
        {
          success: false,
          error: "This case has no faulted AI phase to resume.",
        },
        { status: 409 },
      );
    }
    if (activeClaims > 0) {
      return NextResponse.json(
        {
          success: false,
          error: "AI batches are already active for this case.",
        },
        { status: 409 },
      );
    }
    if (remaining === 0) {
      return NextResponse.json(
        { success: false, error: "No unfinished emails remain to audit." },
        { status: 409 },
      );
    }

    await prisma.$transaction([
      prisma.processedFile.updateMany({
        where: { id: { in: caseIds } },
        data: { ai_status: "pending", batch_id: null },
      }),
      prisma.processedFile.update({
        where: { id: coordinatorId },
        data: {
          ai_started_at: BigInt(Date.now()),
          ai_duration_ms: 0,
          ai_batches_total: 0,
          ai_batches_done: 0,
        },
      }),
    ]);
    const jobId = await enqueueFilePhase({
      fileId: coordinatorId,
      phase: "ai",
      dedupeKey: `ai-resume:${coordinatorId}:${Date.now()}`,
    });

    return NextResponse.json(
      { success: true, jobId, remaining },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unable to resume AI.",
      },
      { status: 500 },
    );
  }
}
