import crypto from "node:crypto";
import { getAiBatchSettings } from "../../src/lib/pipeline-settings";
import { prisma } from "../../src/lib/prisma";
import { uploadSharePointArtifact } from "../../src/lib/sharepoint";
import { refreshSharePointUploadProgress } from "../../src/lib/sharepoint-artifact-outbox";

const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;
const IDLE_POLLS = 5;
const leaseOwner = crypto.randomUUID();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Ensure the singleton row exists before taking the cross-container lease.
  await getAiBatchSettings();
  const lease = await prisma.pipelineSettings.updateMany({
    where: {
      id: "global",
      OR: [
        { sharepoint_upload_lease_until: null },
        { sharepoint_upload_lease_until: { lt: BigInt(Date.now()) } },
      ],
    },
    data: {
      sharepoint_upload_lease_owner: leaseOwner,
      sharepoint_upload_lease_until: BigInt(Date.now() + LEASE_MS),
    },
  });
  if (lease.count === 0) return;

  let idlePolls = 0;
  for (;;) {
    const next = await prisma.sharePointUploadArtifact.findFirst({
      where: {
        status: "pending",
        source_file: {
          case_request: { case: { case_type: "employee" } },
          OR: [
            { kind: "pst", pdf_status: "completed" },
            { kind: "files", files_status: "completed" },
          ],
        },
      },
      orderBy: { created_at: "asc" },
    });
    if (!next) {
      idlePolls++;
      if (idlePolls >= IDLE_POLLS) return;
      await wait(1_000);
      continue;
    }
    idlePolls = 0;
    await prisma.pipelineSettings.updateMany({
      where: { id: "global", sharepoint_upload_lease_owner: leaseOwner },
      data: { sharepoint_upload_lease_until: BigInt(Date.now() + LEASE_MS) },
    });
    const claim = await prisma.sharePointUploadArtifact.updateMany({
      where: { id: next.id, status: "pending" },
      data: {
        status: "processing",
        attempts: { increment: 1 },
        heartbeat_at: BigInt(Date.now()),
      },
    });
    if (claim.count === 0) continue;

    try {
      await uploadSharePointArtifact({
        requestKey: next.request_key,
        localPath: next.local_path,
        relativePath: next.relative_path,
      });
      await prisma.sharePointUploadArtifact.update({
        where: { id: next.id },
        data: {
          status: "completed",
          error_message: null,
          heartbeat_at: BigInt(Date.now()),
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : "Upload failed.";
      const retry =
        next.attempts + 1 < MAX_ATTEMPTS &&
        !/request (400|401|403|404)\b/.test(message);
      await prisma.sharePointUploadArtifact.update({
        where: { id: next.id },
        data: {
          status: retry ? "pending" : "failed",
          error_message: message,
          heartbeat_at: BigInt(Date.now()),
        },
      });
      if (retry) await wait(Math.min(60_000, 2 ** (next.attempts + 1) * 1_000));
    }
    await refreshSharePointUploadProgress(next.source_file_id);
  }
}

main()
  .catch((error) => {
    console.error("[sharepoint-artifact-worker] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.pipelineSettings.updateMany({
      where: { id: "global", sharepoint_upload_lease_owner: leaseOwner },
      data: {
        sharepoint_upload_lease_owner: null,
        sharepoint_upload_lease_until: null,
      },
    });
    await prisma.$disconnect();
  });
