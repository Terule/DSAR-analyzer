import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCasePstFileIds } from "@/lib/case-utils";
import {
  cancelJobsForFiles,
  clearFilesBatchResults,
  countPendingCancellation,
} from "@/lib/control-plane/job-store";
import {
  enqueueFilePhase,
  isControlPlanePipelineEnabled,
} from "@/lib/control-plane/pipeline";
import { prisma } from "@/lib/prisma";
import { getPstArtifactPaths } from "@/lib/pst-artifacts";

export const dynamic = "force-dynamic";

async function waitForWorkerCancellation(fileId: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await countPendingCancellation([fileId])) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function clearFilesDeliverables(filepath: string): void {
  const stagingPath = process.env.STAGING_PATH || "";
  const outputPath = process.env.EXTRACTED_PATH || "";
  const relative = path.relative(stagingPath, filepath);
  if (!outputPath || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Files output path cannot be resolved safely.");
  }
  const caseOutputPath = path.join(outputPath, path.dirname(relative));
  for (const folder of ["Messages", "Documents"]) {
    fs.rmSync(path.join(caseOutputPath, folder), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }
}

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
      select: {
        status: true,
        pdf_status: true,
        ai_status: true,
        kind: true,
        files_status: true,
        total_emails: true,
        unique_emails: true,
        filepath: true,
      },
    });

    if (!row) {
      return NextResponse.json(
        { success: false, error: "File not found" },
        { status: 404 },
      );
    }

    let phase: "parse" | "extract" | "ai" | "render" | "files" | undefined;

    // 1. Requeue a failed/timed-out Files folder. Its source data remains in
    // staging, so this is safe without restarting Parse/Extract/AI.
    if (row.kind === "files" && row.files_status !== "completed") {
      // Stop every in-flight batch before removing its shared deliverables.
      // The dispatcher owns container termination; this endpoint waits until
      // it has acknowledged the cancellation before deleting output.
      await cancelJobsForFiles([fileId], "Cancelled for Files-only restart");
      if (!(await waitForWorkerCancellation(fileId))) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Files workers did not stop in time; restart was not applied.",
          },
          { status: 409 },
        );
      }
      if (!row.filepath) {
        return NextResponse.json(
          { success: false, error: "Files row has no input path." },
          { status: 400 },
        );
      }
      clearFilesDeliverables(row.filepath);
      await clearFilesBatchResults(fileId);
      await prisma.processedFile.update({
        where: { id: fileId },
        data: {
          files_status: "pending",
          files_started_at: null,
          files_paused_ms: 0,
          files_total: 0,
          files_processed: 0,
          files_skipped: 0,
          files_duplicates: 0,
          files_duration_ms: 0,
        },
      });
      phase = "files";
    }
    // 2. Reset PDF compilation failures. Render is case-level (all PST files in
    // the request share the selected/ folder), so reset every PST row in the case.
    if (row.pdf_status === "failed") {
      const caseIds = await getCasePstFileIds(fileId);
      await prisma.processedFile.updateMany({
        where: { id: { in: caseIds } },
        data: { pdf_status: "pending", pdf_duration_ms: 0 },
      });
      phase = "render";
    }
    // 3. Reset AI Batch processing failures. AI is case-level (one run audits
    // the whole request), so reset every PST row; the coordinator re-runs and
    // resumes from undecided emails.
    else if (row.ai_status === "failed") {
      const caseIds = await getCasePstFileIds(fileId);
      await prisma.processedFile.updateMany({
        where: { id: { in: caseIds } },
        data: { ai_status: "pending", ai_started_at: null },
      });
      phase = "ai";
    }
    // 4. Reset standard pipeline failures (metadata, analyze, extract). These
    // are inherently per-file (each PST is parsed/extracted independently).
    else if (row.status === "failed") {
      const rawArtifact = row.filepath
        ? getPstArtifactPaths({
            fileId,
            filepath: row.filepath,
            stagingPath: process.env.STAGING_PATH || "",
            extractedPath: process.env.EXTRACTED_PATH || "",
          }).rawEmlFolder
        : null;
      // Missing/partial Parse output must be rebuilt, regardless of old DB
      // counters. This is the normal recovery path after an OOM-killed worker.
      if (
        !rawArtifact ||
        !fs.existsSync(rawArtifact) ||
        row.total_emails === 0
      ) {
        await prisma.processedFile.update({
          where: { id: fileId },
          data: { status: "pending_analysis" },
        });
        phase = "parse";
      }
      // If analysis never completed, reset to pending analysis
      else if (row.unique_emails === 0) {
        await prisma.processedFile.update({
          where: { id: fileId },
          data: { status: "pending_analysis" },
        });
        phase = "parse";
      }
      // Otherwise, if it failed during extraction, reset to analyzed
      else {
        await prisma.processedFile.update({
          where: { id: fileId },
          data: { status: "analyzed" },
        });
        phase = "extract";
      }
    }

    if (phase && isControlPlanePipelineEnabled()) {
      await enqueueFilePhase({ fileId, phase });
    }

    return NextResponse.json(
      {
        success: true,
        message: phase
          ? `Recovery job queued for ${phase}.`
          : "State successfully reverted.",
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Retry API Route Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
