import { removeRequestFolders } from "./cases";
import { cancelJobsForFiles } from "./control-plane/job-store";
import { prisma } from "./prisma";

const WORKING = ["queued", "running", "stopping"];

/**
 * Takes a request back to "ready": cancels its jobs, removes what it delivered
 * and the rows it produced, including its audit trail. The case, its subject
 * and the source files in the input folder are kept.
 */
export async function resetRequestData(requestId: string): Promise<void> {
  const item = await prisma.caseRequest.findUnique({
    where: { id: requestId },
    include: { processed_files: { select: { id: true } } },
  });
  if (!item) throw new Error("Request not found.");
  const fileIds = item.processed_files.map((file) => file.id);
  await cancelJobsForFiles(fileIds, "Reset by user");
  await removeRequestFolders([item], false);
  await prisma.$transaction([
    prisma.sharePointUploadArtifact.deleteMany({
      where: { source_file_id: { in: fileIds } },
    }),
    prisma.email.deleteMany({ where: { file_id: { in: fileIds } } }),
    // The audit trail belongs to the run that is being removed.
    prisma.item.deleteMany({ where: { case_request_id: requestId } }),
    prisma.processedFile.deleteMany({ where: { case_request_id: requestId } }),
    prisma.caseRequest.update({
      where: { id: requestId },
      data: {
        status: "ready",
        started_at: null,
        completed_at: null,
        error: null,
        deliverable_files: 0,
        deliverable_size_bytes: BigInt(0),
        total_emails: 0,
        emails_exported: 0,
        files_exported: 0,
        wave: 1,
        wave_scope: null,
        render_base: null,
        warning_base: null,
        files_doc_base: null,
        files_msg_base: null,
      },
    }),
  ]);
}

/**
 * Wipes the output of every request of a case, keeping the case, its subject
 * and its requests. Refused while work is running and unless the case name is
 * typed exactly.
 */
export async function wipeCaseData(
  caseId: string,
  confirmation: string,
): Promise<number> {
  const item = await prisma.managedCase.findUnique({
    where: { id: caseId },
    include: { requests: { select: { id: true, status: true } } },
  });
  if (!item || item.status !== "active") {
    throw new Error("Active case not found.");
  }
  if (confirmation !== item.name) {
    throw new Error("Type the case name exactly to confirm.");
  }
  if (item.requests.some((request) => WORKING.includes(request.status))) {
    throw new Error("Stop all work on this case before wiping its data.");
  }
  for (const request of item.requests) {
    await resetRequestData(request.id);
  }
  return item.requests.length;
}
