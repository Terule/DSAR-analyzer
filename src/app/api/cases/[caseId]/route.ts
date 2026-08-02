import { NextResponse } from "next/server";
import { cancelOpenAiBatchesForFiles } from "@/lib/ai";
import { configureManagedCase, removeRequestFolders } from "@/lib/cases";
import {
  cancelJobsForFiles,
  countPendingCancellation,
} from "@/lib/control-plane/job-store";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const configured = await configureManagedCase(caseId, await request.json());
    return NextResponse.json({ case: configured });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to configure case.",
      },
      { status: 400 },
    );
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const item = await prisma.managedCase.findUnique({
      where: { id: caseId },
      include: {
        requests: { include: { processed_files: { select: { id: true } } } },
      },
    });
    if (!item || item.status !== "active")
      throw new Error("Active case not found.");
    const fileIds = item.requests.flatMap((entry) =>
      entry.processed_files.map((file) => file.id),
    );
    await Promise.all([
      cancelJobsForFiles(fileIds, "Stopped before case deletion"),
      cancelOpenAiBatchesForFiles(fileIds),
    ]);
    const pending = await countPendingCancellation(fileIds);
    if (pending > 0) {
      await prisma.caseRequest.updateMany({
        where: { case_id: caseId, status: { in: ["queued", "running"] } },
        data: { status: "stopping", error: "Stopping before case deletion" },
      });
      return NextResponse.json({ stopped: false, pending }, { status: 202 });
    }
    await prisma.caseRequest.updateMany({
      where: {
        case_id: caseId,
        status: { in: ["queued", "running", "stopping"] },
      },
      data: { status: "ready", started_at: null, error: "Stopped by user" },
    });
    return NextResponse.json({ stopped: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to stop case.",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const { confirmation } = await request.json();
    const item = await prisma.managedCase.findUnique({
      where: { id: caseId },
      include: {
        requests: { include: { processed_files: { select: { id: true } } } },
      },
    });
    if (!item) throw new Error("Case not found.");
    if (confirmation !== item.name)
      throw new Error("Type the exact case name to confirm deletion.");
    if (
      item.requests.some((entry) =>
        ["queued", "running", "stopping"].includes(entry.status),
      )
    ) {
      throw new Error("Stop all active work before deleting this case.");
    }
    const ids = item.requests.flatMap((entry) =>
      entry.processed_files.map((file) => file.id),
    );
    if (ids.length) await cancelJobsForFiles(ids, "Deleted by user");
    await removeRequestFolders(item.requests, true);
    await prisma.$transaction([
      prisma.sharePointUploadArtifact.deleteMany({
        where: { source_file_id: { in: ids } },
      }),
      prisma.email.deleteMany({ where: { file_id: { in: ids } } }),
      prisma.aiBatchRun.deleteMany({ where: { coordinator_id: { in: ids } } }),
    ]);
    await prisma.managedCase.delete({ where: { id: caseId } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to delete case.",
      },
      { status: 400 },
    );
  }
}
