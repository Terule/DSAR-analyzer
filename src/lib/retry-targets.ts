interface RetryRow {
  id: string;
  kind: string;
  status: string;
  ai_status: string;
  pdf_status: string;
  files_status: string;
}

/**
 * The rows the dashboard's Retry should re-run for a request, upstream steps
 * first (Parse/Extract, then AI, then Render, then Files). AI and Render run
 * once per case, and the retry operation resets every PST row of the case from
 * any one of them, so each is represented by a single row. A row appears once.
 */
export function retryTargets(rows: RetryRow[]): string[] {
  const targets: string[] = [];
  const add = (id: string | undefined) => {
    if (id !== undefined && !targets.includes(id)) targets.push(id);
  };
  const pst = rows.filter((row) => row.kind === "pst");
  for (const row of pst) if (row.status === "failed") add(row.id);
  add(pst.find((row) => row.ai_status === "failed")?.id);
  add(pst.find((row) => row.pdf_status === "failed")?.id);
  for (const row of rows) {
    if (row.kind === "files" && row.files_status === "failed") add(row.id);
  }
  return targets;
}
