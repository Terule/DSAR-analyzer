import { prisma } from "./prisma";
import { startSharePointArtifactWorker } from "./sharepoint-artifact-queue";

/**
 * Recovers SharePoint uploads whose worker died and starts a worker if any
 * upload is waiting. The upload worker is a separate process started by
 * whichever process queued the files; when that was a one-shot Render
 * container it vanished seconds later and the upload sat orphaned. Anything
 * long-lived (the dispatcher) calls this periodically, and the dashboard stream
 * calls it on connect. The worker takes a database lease, so extra starts are
 * harmless.
 */
export async function resumeSharePointUploads(
  start: () => void = startSharePointArtifactWorker,
): Promise<void> {
  const staleBefore = BigInt(Date.now() - 60_000);
  // Old client runs may have been queued before client cases became
  // deduplication-only. Clear their misleading upload state.
  await prisma.processedFile.updateMany({
    where: {
      case_request: { case: { case_type: "client" } },
      upload_status: { not: "idle" },
    },
    data: {
      upload_status: "idle",
      upload_total: 0,
      upload_uploaded: 0,
      upload_error: null,
    },
  });
  await prisma.sharePointUploadArtifact.updateMany({
    where: {
      status: "processing",
      source_file: {
        case_request: { case: { case_type: "employee" } },
        OR: [
          { kind: "pst", pdf_status: "completed" },
          { kind: "files", files_status: "completed" },
        ],
      },
      OR: [{ heartbeat_at: null }, { heartbeat_at: { lt: staleBefore } }],
    },
    data: { status: "pending" },
  });
  const pendingArtifacts = await prisma.sharePointUploadArtifact.count({
    where: {
      status: "pending",
      source_file: {
        case_request: { case: { case_type: "employee" } },
      },
    },
  });
  if (pendingArtifacts > 0) start();
}
