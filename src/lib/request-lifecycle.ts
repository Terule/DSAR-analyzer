export interface LifecycleRow {
  id: string;
  kind: string;
  pdf_status: string;
  files_status: string;
}

/**
 * A request is done when every source row reached its last phase. A row that
 * reads "failed" counts only when no durable job still works on it: a Files
 * batch that dead-letters flips the row to failed while hundreds of sibling
 * batches keep going, and the dispatcher flips it back on its next sweep. A
 * request must not read "completed" in that gap.
 */
export async function lifecycleRowsDone(
  rows: LifecycleRow[],
  hasActiveJob: (fileId: string, phase: "files" | "render") => Promise<boolean>,
): Promise<boolean> {
  for (const row of rows) {
    const phase = row.kind === "files" ? "files" : "render";
    const status = row.kind === "files" ? row.files_status : row.pdf_status;
    if (status === "completed") continue;
    if (status === "failed" && !(await hasActiveJob(row.id, phase))) continue;
    return false;
  }
  return true;
}
