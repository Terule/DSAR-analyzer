import { NextResponse } from "next/server";
import {
  enqueueFilePhase,
  isControlPlanePipelineEnabled,
} from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";

// Prevent Vercel/Next.js from caching this route statically
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fileId } = body;

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: fileId" },
        { status: 400 },
      );
    }

    // Check file status in DB
    const row = await prisma.processedFile.findUnique({
      where: { id: fileId },
      select: { ai_status: true, pdf_status: true },
    });

    if (!row) {
      return NextResponse.json(
        { success: false, error: "File record not found." },
        { status: 404 },
      );
    }

    // Ensure AI audit is finished first
    if (row.ai_status !== "completed") {
      return NextResponse.json(
        {
          success: false,
          error: "AI Audit must be completed before generating PDFs.",
        },
        { status: 400 },
      );
    }

    // Prevent double-triggering
    if (row.pdf_status === "processing") {
      return NextResponse.json(
        { success: false, error: "PDF conversion is already in progress." },
        { status: 409 },
      );
    }

    // Enqueue this file. The worker will claim it when it's its turn.
    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        pdf_status: "pending",
        pdf_duration_ms: 0,
        pdf_total: 0,
        pdf_processed: 0,
      },
    });

    console.log(`Queued PDF conversion for file: ${fileId}`);

    if (!isControlPlanePipelineEnabled()) {
      throw new Error("The local control-plane pipeline is not configured.");
    }
    await enqueueFilePhase({ fileId, phase: "render" });

    return NextResponse.json(
      { success: true, message: "PDF conversion queued." },
      { status: 202 },
    );
  } catch (error) {
    console.error("API route /api/convert encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
