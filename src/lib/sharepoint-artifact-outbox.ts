import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getCaseKey } from "./format";
import { prisma } from "./prisma";

export async function refreshSharePointUploadProgress(
  fileId: string,
): Promise<void> {
  const [total, completed, active] = await Promise.all([
    prisma.sharePointUploadArtifact.count({
      where: { source_file_id: fileId },
    }),
    prisma.sharePointUploadArtifact.count({
      where: { source_file_id: fileId, status: "completed" },
    }),
    prisma.sharePointUploadArtifact.count({
      where: {
        source_file_id: fileId,
        status: { in: ["pending", "processing"] },
      },
    }),
  ]);
  await prisma.processedFile.update({
    where: { id: fileId },
    data: {
      upload_status:
        total === 0 ? "idle" : active > 0 ? "processing" : "completed",
      upload_total: total,
      upload_uploaded: completed,
      upload_error: null,
      upload_heartbeat_at: BigInt(Date.now()),
    },
  });
}

/** Queue verified files without blocking the render/files producer. */
export async function queueSharePointArtifacts(
  fileId: string,
  localPaths: Iterable<string>,
): Promise<number> {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { filepath: true },
  });
  if (!row?.filepath) return 0;
  const outputRoot = process.env.EXTRACTED_PATH;
  if (!outputRoot) throw new Error("EXTRACTED_PATH is not configured.");
  const requestKey = getCaseKey(row.filepath);
  const requestRoot = path.resolve(outputRoot, requestKey);
  let queued = 0;

  for (const candidate of localPaths) {
    const localPath = path.resolve(candidate);
    const relativePath = path.relative(requestRoot, localPath);
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      relativePath.startsWith(".")
    ) {
      continue;
    }
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(localPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;

    const existing = await prisma.sharePointUploadArtifact.findUnique({
      where: { local_path: localPath },
      select: { file_size_bytes: true, modified_at: true, status: true },
    });
    const modifiedAt = BigInt(Math.floor(stat.mtimeMs));
    const size = BigInt(stat.size);
    if (
      existing &&
      existing.file_size_bytes === size &&
      existing.modified_at === modifiedAt
    ) {
      if (existing.status !== "failed") continue;
    }
    if (existing) {
      await prisma.sharePointUploadArtifact.update({
        where: { local_path: localPath },
        data: {
          source_file_id: fileId,
          request_key: requestKey,
          relative_path: relativePath,
          file_size_bytes: size,
          modified_at: modifiedAt,
          status: "pending",
          attempts: 0,
          error_message: null,
          heartbeat_at: BigInt(Date.now()),
        },
      });
    } else {
      await prisma.sharePointUploadArtifact.create({
        data: {
          id: crypto.randomUUID(),
          source_file_id: fileId,
          request_key: requestKey,
          local_path: localPath,
          relative_path: relativePath,
          file_size_bytes: size,
          modified_at: modifiedAt,
          status: "pending",
          heartbeat_at: BigInt(Date.now()),
        },
      });
    }
    queued++;
  }

  if (queued > 0) await refreshSharePointUploadProgress(fileId);
  return queued;
}
