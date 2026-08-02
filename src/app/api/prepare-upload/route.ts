import fs from "node:fs";
import path from "node:path";
import { getCaseKey } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { queueSharePointArtifacts } from "@/lib/sharepoint-artifact-outbox";
import { startSharePointArtifactWorker } from "@/lib/sharepoint-artifact-queue";
import { removeDsStoreFiles } from "@/lib/upload-prep";

export async function POST(request: Request) {
  let fileIds: string[] = [];
  try {
    const body = await request.json();
    fileIds = body.fileIds;
    if (
      !Array.isArray(fileIds) ||
      fileIds.length === 0 ||
      fileIds.some((id) => typeof id !== "string")
    ) {
      return Response.json(
        { error: "fileIds must be an array of strings." },
        { status: 400 },
      );
    }

    const rows = await prisma.processedFile.findMany({
      where: { id: { in: fileIds } },
      select: { filepath: true },
    });
    const outputRoot = process.env.EXTRACTED_PATH;
    if (!outputRoot) throw new Error("EXTRACTED_PATH is not configured.");

    const requests = new Set(
      rows.flatMap((row) => (row.filepath ? [getCaseKey(row.filepath)] : [])),
    );
    let removed = 0;
    for (const requestKey of requests) {
      removed += removeDsStoreFiles(path.join(outputRoot, requestKey));
    }
    const artifacts = [...requests].flatMap((requestKey) => {
      const root = path.join(outputRoot, requestKey);
      if (!fs.existsSync(root)) return [];
      return fs
        .readdirSync(root, { recursive: true })
        .map((entry) => path.join(root, String(entry)))
        .filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile());
    });
    const queued = await queueSharePointArtifacts(fileIds[0], artifacts);
    if (queued > 0) startSharePointArtifactWorker();

    return Response.json(
      { success: true, removed, uploadTotal: artifacts.length },
      { status: 202 },
    );
  } catch (error) {
    console.error("[Prepare Upload] Failed:", error);
    if (fileIds.length > 0) {
      await prisma.processedFile.updateMany({
        where: { id: { in: fileIds } },
        data: {
          upload_status: "failed",
          upload_error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Upload failed.",
        },
      });
    }
    return Response.json(
      { error: "Could not prepare the upload." },
      { status: 500 },
    );
  }
}
