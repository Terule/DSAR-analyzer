import { NextResponse } from "next/server";
import { analyzePstDuplicates } from "@/lib/analyzer";
import {
  enqueueFilePhase,
  isControlPlanePipelineEnabled,
} from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { fileId } = await request.json();

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    const row = await prisma.processedFile.findUnique({
      where: { id: fileId },
      select: { id: true, status: true },
    });

    if (!row) {
      return NextResponse.json(
        { success: false, error: "File not found." },
        { status: 404 },
      );
    }

    if (row.status !== "pending_analysis") {
      return NextResponse.json(
        {
          success: false,
          error: "File must complete metadata scanning first.",
        },
        { status: 400 },
      );
    }

    await prisma.processedFile.update({
      where: { id: fileId },
      data: { status: "processing" },
    });

    if (isControlPlanePipelineEnabled()) {
      await enqueueFilePhase({ fileId, phase: "parse" });
      return NextResponse.json(
        { success: true, message: "Analysis queued" },
        { status: 202 },
      );
    }

    // ⏱ 1. Start Clock
    const startTime = Date.now();

    await analyzePstDuplicates(fileId);

    // ⏱ 2. Calculate and Save Clock
    const durationMs = Date.now() - startTime;
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { analyze_duration_ms: { increment: durationMs } },
    });

    return NextResponse.json(
      { success: true, message: "Analysis completed" },
      { status: 200 },
    );
  } catch (error) {
    console.error(`API route /api/analyze encountered an error:`, error);
    return NextResponse.json(
      { success: false, error: "Analysis failed." },
      { status: 500 },
    );
  }
}
