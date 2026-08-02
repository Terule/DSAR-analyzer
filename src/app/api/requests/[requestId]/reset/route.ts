import { NextResponse } from "next/server";
import { removeRequestFolders } from "@/lib/cases";
import { cancelJobsForFiles } from "@/lib/control-plane/job-store";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await context.params;
    const item = await prisma.caseRequest.findUnique({
      where: { id: requestId },
      include: { processed_files: { select: { id: true } } },
    });
    if (!item) throw new Error("Request not found.");
    await cancelJobsForFiles(
      item.processed_files.map((file) => file.id),
      "Reset by user",
    );
    await removeRequestFolders([item], false);
    await prisma.$transaction([
      prisma.sharePointUploadArtifact.deleteMany({
        where: {
          source_file_id: { in: item.processed_files.map((file) => file.id) },
        },
      }),
      prisma.email.deleteMany({
        where: { file_id: { in: item.processed_files.map((file) => file.id) } },
      }),
      prisma.processedFile.deleteMany({
        where: { case_request_id: requestId },
      }),
      prisma.caseRequest.update({
        where: { id: requestId },
        data: {
          status: "ready",
          started_at: null,
          completed_at: null,
          error: null,
          deliverable_files: 0,
          deliverable_size_bytes: BigInt(0),
          total_emails: 0,
          emails_exported: 0,
          files_exported: 0,
        },
      }),
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to reset request.",
      },
      { status: 400 },
    );
  }
}
