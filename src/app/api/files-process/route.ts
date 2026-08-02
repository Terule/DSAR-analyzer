import { NextResponse } from "next/server";
import {
  enqueueFilePhase,
  isControlPlanePipelineEnabled,
} from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

interface FilesProcessBody {
  fileId: string;
  subjectCriteria?: {
    name: string;
    email?: string;
    personalEmail?: string;
    aliases?: string[];
  };
}

export async function POST(request: Request) {
  try {
    const { fileId, subjectCriteria } =
      (await request.json()) as FilesProcessBody;

    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Missing fileId" },
        { status: 400 },
      );
    }

    const row = await prisma.processedFile.findFirst({
      where: { id: fileId, kind: "files" },
      select: { id: true, subject_name: true, subject_aliases: true },
    });

    if (!row) {
      return NextResponse.json(
        { success: false, error: "Files row not found" },
        { status: 404 },
      );
    }

    // Persist subject criteria (shared with the AI audit config) when provided.
    if (subjectCriteria?.name) {
      await prisma.processedFile.update({
        where: { id: fileId },
        data: {
          subject_name: subjectCriteria.name,
          subject_email: subjectCriteria.email || "",
          subject_personal_email: subjectCriteria.personalEmail || null,
          subject_aliases: (subjectCriteria.aliases || []).join(", "),
        },
      });
    }

    await prisma.processedFile.update({
      where: { id: fileId },
      data: {
        files_status: "processing",
        files_started_at: BigInt(Date.now()),
        files_paused_ms: 0,
        files_duration_ms: 0,
      },
    });

    if (!isControlPlanePipelineEnabled()) {
      throw new Error("The local control-plane pipeline is not configured.");
    }
    await enqueueFilePhase({ fileId, phase: "files" });

    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    console.error("API route /api/files-process error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
