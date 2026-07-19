import { NextResponse } from "next/server";
import { scanFileMetadata } from "@/lib/analyzer";
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
      select: { status: true },
    });

    if (!row || row.status !== "pending") {
      return NextResponse.json(
        { success: false, error: "Invalid status for metadata scan." },
        { status: 400 },
      );
    }

    await prisma.processedFile.update({
      where: { id: fileId },
      data: { status: "scanning_metadata" },
    });

    if (isControlPlanePipelineEnabled()) {
      await enqueueFilePhase({ fileId, phase: "parse" });
      return NextResponse.json({ success: true }, { status: 202 });
    }

    // Timeout de 100ms destrava o botão instantaneamente
    setTimeout(() => {
      scanFileMetadata(fileId).catch(async (err: unknown) => {
        console.error(`Metadata background worker crashed for ${fileId}:`, err);
        await prisma.processedFile.update({
          where: { id: fileId },
          data: { status: "failed" },
        });
      });
    }, 100);

    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    console.error("Metadata API Error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
