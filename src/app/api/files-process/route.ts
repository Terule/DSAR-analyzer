import { spawn } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { openWorkerLogFd } from "@/lib/worker-log";

export const dynamic = "force-dynamic";

interface FilesProcessBody {
  fileId: string;
  subjectCriteria?: { name: string; email?: string; aliases?: string[] };
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

    const row = db
      .prepare(
        "SELECT id, subject_name, subject_aliases FROM processed_files WHERE id = ? AND kind = 'files'",
      )
      .get(fileId) as
      | { id: string; subject_name?: string; subject_aliases?: string }
      | undefined;

    if (!row) {
      return NextResponse.json(
        { success: false, error: "Files row not found" },
        { status: 404 },
      );
    }

    // Persist subject criteria (shared with the AI audit config) when provided.
    if (subjectCriteria?.name) {
      db.prepare(
        `UPDATE processed_files
         SET subject_name = ?, subject_email = ?, subject_aliases = ?
         WHERE id = ?`,
      ).run(
        subjectCriteria.name,
        subjectCriteria.email || "",
        (subjectCriteria.aliases || []).join(", "),
        fileId,
      );
    }

    db.prepare(
      `UPDATE processed_files
       SET files_status = 'processing', files_started_at = ?, files_duration_ms = 0
       WHERE id = ?`,
    ).run(Date.now(), fileId);

    const workerPath = path.resolve(process.cwd(), "files-worker.ts");
    const logFd = openWorkerLogFd("files-worker");
    const child = spawn("bun", [workerPath, fileId], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("API route /api/files-process error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
