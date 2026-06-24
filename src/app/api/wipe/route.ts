import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { caseName, fileIds } = await request.json();

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "Missing fileIds" },
        { status: 400 },
      );
    }

    const stagingPath =
      process.env.STAGING_PATH || "/Users/rgomes/Projects/staging-area";
    const extractedPath =
      process.env.EXTRACTED_PATH || "/Users/rgomes/Projects/extracted_emails";

    const placeholders = fileIds.map(() => "?").join(",");

    // Retrieve the exact file paths to correctly identify the extracted folders
    const filesToReset = db
      .prepare(
        `SELECT id, filepath FROM processed_files WHERE id IN (${placeholders})`,
      )
      .all(...fileIds) as { id: string; filepath: string }[];

    // 1. Delete all child emails from the database for this case
    db.prepare(`DELETE FROM emails WHERE file_id IN (${placeholders})`).run(
      ...fileIds,
    );

    // 2. Reset the parent files completely back to zero
    db.prepare(`
      UPDATE processed_files 
      SET status = 'pending', 
          ai_status = 'pending', 
          pdf_status = 'pending',
          total_emails = 0,
          total_attachments = 0,
          unique_emails = 0,
          duplicate_emails = 0,
          estimated_tokens = 0,
          ai_approved_count = 0,
          ai_discarded_count = 0,
          batch_id = NULL
      WHERE id IN (${placeholders})
    `).run(...fileIds);

    // 3. Wipe the hard drive working folders for these specific files
    for (const file of filesToReset) {
      let relativeSystemPath = path.relative(stagingPath, file.filepath);
      if (
        relativeSystemPath.startsWith("..") ||
        path.isAbsolute(relativeSystemPath)
      ) {
        relativeSystemPath = file.id;
      }

      let cleanRelativePath = path.dirname(relativeSystemPath);
      if (cleanRelativePath === "." || cleanRelativePath === "") {
        cleanRelativePath = path.parse(relativeSystemPath).name;
      }

      const targetFolder = path.join(extractedPath, cleanRelativePath);
      if (fs.existsSync(targetFolder)) {
        fs.rmSync(targetFolder, { recursive: true, force: true });
      }
    }

    console.log(
      `[Reset Engine] Successfully wiped and reset files for Case: ${caseName || "Unknown"}`,
    );

    return NextResponse.json(
      { success: true, message: `Case reset successfully.` },
      { status: 200 },
    );
  } catch (error) {
    console.error("API route /api/reset-case encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
