import path from "node:path";
import { getCaseKey } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { removeDsStoreFiles } from "@/lib/upload-prep";

export async function POST(request: Request) {
  try {
    const { fileIds } = await request.json();
    if (
      !Array.isArray(fileIds) ||
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

    return Response.json({ success: true, removed });
  } catch (error) {
    console.error("[Prepare Upload] Failed:", error);
    return Response.json(
      { error: "Could not prepare the upload." },
      { status: 500 },
    );
  }
}
