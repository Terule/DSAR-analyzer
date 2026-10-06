import path from "node:path";
import { getCasePstFileIds } from "./case-utils";
import { getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";
import {
  allWaveRowsFinished,
  deletePstFiles,
  waveDeliveredOutput,
} from "./source-prune-rules";

export type PruneOutcome =
  | { deleted: number }
  | {
      deleted: 0;
      skipped: "disabled" | "unmanaged" | "not-finished" | "no-output";
    };

/**
 * Frees disk space once a wave's source PSTs are guaranteed unnecessary: the
 * setting is on, every PST row of the wave finished Parse/Extract, AI and
 * Render, and the wave's Email/Warning PDFs are on disk above its numbering
 * base. Only the files recorded as this wave's rows, and only inside the
 * request's own `PST/` folder, are deleted; the rows and their email hashes
 * stay (see `isRenderedSourceRow`) so later waves still deduplicate.
 */
export async function pruneWaveSourcePsts(
  fileId: string,
): Promise<PruneOutcome> {
  const settings = await getAiBatchSettings();
  if (!settings.deleteSourcePsts) return { deleted: 0, skipped: "disabled" };

  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { case_request_id: true },
  });
  if (!row?.case_request_id) return { deleted: 0, skipped: "unmanaged" };

  const request = await prisma.caseRequest.findUnique({
    where: { id: row.case_request_id },
    select: {
      staging_path: true,
      deliverable_path: true,
      render_base: true,
      warning_base: true,
    },
  });
  if (!request) return { deleted: 0, skipped: "unmanaged" };

  const ids = await getCasePstFileIds(fileId);
  const rows = await prisma.processedFile.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      filepath: true,
      status: true,
      ai_status: true,
      pdf_status: true,
    },
  });
  if (!allWaveRowsFinished(rows)) {
    return { deleted: 0, skipped: "not-finished" };
  }

  const delivered = waveDeliveredOutput(
    path.join(request.deliverable_path, "Emails"),
    { email: request.render_base ?? 0, warning: request.warning_base ?? 0 },
  );
  if (!delivered) return { deleted: 0, skipped: "no-output" };

  const deleted = deletePstFiles(
    path.join(request.staging_path, "PST"),
    rows.flatMap((item) => (item.filepath ? [item.filepath] : [])),
  );
  return { deleted: deleted.length };
}
