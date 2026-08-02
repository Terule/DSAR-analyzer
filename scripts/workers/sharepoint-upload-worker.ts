import { getCaseKey } from "../../src/lib/format";
import { prisma } from "../../src/lib/prisma";
import { uploadCaseDeliverables } from "../../src/lib/sharepoint";

const MAX_UPLOAD_ATTEMPTS = 5;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return !/request (400|401|403|404)\b/.test(message);
}

async function main() {
  const encodedIds = process.argv[2];
  if (!encodedIds)
    throw new Error("[sharepoint-upload-worker] Missing file IDs.");
  const fileIds = JSON.parse(encodedIds) as string[];
  if (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== "string")) {
    throw new Error("[sharepoint-upload-worker] Invalid file IDs.");
  }

  // Atomically claim a queued upload. A stale upload is reset to pending by
  // the dashboard event route before a replacement worker is launched.
  const claim = await prisma.processedFile.updateMany({
    where: { id: { in: fileIds }, upload_status: "pending" },
    data: {
      upload_status: "processing",
      upload_error: null,
      upload_heartbeat_at: BigInt(Date.now()),
    },
  });
  if (claim.count === 0) return;

  const rows = await prisma.processedFile.findMany({
    where: { id: { in: fileIds } },
    select: { filepath: true, upload_uploaded: true },
  });
  const requestKeys = new Set(
    rows.flatMap((row) => (row.filepath ? [getCaseKey(row.filepath)] : [])),
  );
  let resumeFrom = Math.min(...rows.map((row) => row.upload_uploaded));

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    try {
      const result = await uploadCaseDeliverables(
        requestKeys,
        async (uploaded) => {
          resumeFrom = uploaded;
          await prisma.processedFile.updateMany({
            where: { id: { in: fileIds } },
            data: {
              upload_uploaded: uploaded,
              upload_heartbeat_at: BigInt(Date.now()),
            },
          });
        },
        Number.isFinite(resumeFrom) ? resumeFrom : 0,
      );
      await prisma.processedFile.updateMany({
        where: { id: { in: fileIds } },
        data: {
          upload_status: "completed",
          upload_uploaded: result.filesUploaded,
          upload_total: result.filesTotal,
          upload_error: null,
          upload_heartbeat_at: BigInt(Date.now()),
        },
      });
      return;
    } catch (error) {
      if (attempt === MAX_UPLOAD_ATTEMPTS || !retryable(error)) {
        await prisma.processedFile.updateMany({
          where: { id: { in: fileIds } },
          data: {
            upload_status: "failed",
            upload_error:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Upload failed.",
            upload_heartbeat_at: BigInt(Date.now()),
          },
        });
        throw error;
      }
      const delayMs = Math.min(60_000, 2 ** attempt * 1_000);
      await prisma.processedFile.updateMany({
        where: { id: { in: fileIds } },
        data: {
          upload_error: `Retrying after attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS}.`,
          upload_heartbeat_at: BigInt(Date.now()),
        },
      });
      await wait(delayMs);
    }
  }
}

main()
  .catch((error) => {
    console.error("[sharepoint-upload-worker] Failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
