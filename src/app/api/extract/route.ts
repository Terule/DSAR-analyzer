import { NextResponse } from "next/server";
import {
  enqueueFilePhase,
  isControlPlanePipelineEnabled,
} from "@/lib/control-plane/pipeline";
import { extractUniqueEmails } from "@/lib/exporter";
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

    if (row.status !== "analyzed") {
      return NextResponse.json(
        {
          success: false,
          error: "File must be analyzed first before extraction.",
        },
        { status: 400 },
      );
    }

    if (isControlPlanePipelineEnabled()) {
      await enqueueFilePhase({ fileId, phase: "extract" });
      return NextResponse.json(
        { success: true, message: "Extraction queued" },
        { status: 202 },
      );
    }

    // ⏱ Start Clock
    const startTime = Date.now();

    // CRITICAL FIX: Await the heavy I/O to ensure all JSONs are written to disk securely
    await extractUniqueEmails(fileId);

    // ⏱ Save extraction duration
    const durationMs = Date.now() - startTime;
    await prisma.processedFile.update({
      where: { id: fileId },
      data: { extract_duration_ms: { increment: durationMs } },
    });

    return NextResponse.json(
      { success: true, message: "Extraction completed" },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/extract encountered an error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
