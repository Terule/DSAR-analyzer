interface StatusRow {
  status: string;
}

const PARSING = ["scanning_metadata", "processing", "pending_analysis"];

/**
 * Parse covers every PST of the request, so one PST being scanned means the
 * whole phase is active; reading only the first row made the tile say
 * "Waiting" for as long as that row sat in `scanning_metadata`.
 */
export function parsePhaseStatus(rows: StatusRow[]): string {
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (rows.some((row) => PARSING.includes(row.status))) return "processing";
  return rows[0]?.status || "pending";
}

export function extractPhaseStatus(rows: StatusRow[]): string {
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (rows.some((row) => row.status === "extracting")) return "extracting";
  if (rows.length > 0 && rows.every((row) => row.status === "completed")) {
    return "completed";
  }
  return "pending";
}

interface RenderRow {
  pdf_status: string;
}

/**
 * Render is case-level and its state lives on the coordinator row, which is
 * not necessarily the first PST. Look at every row so a failed Render shows.
 */
export function renderPhaseStatus(rows: RenderRow[]): string {
  if (rows.some((row) => row.pdf_status === "failed")) return "failed";
  if (rows.length > 0 && rows.every((row) => row.pdf_status === "completed")) {
    return "completed";
  }
  if (rows.some((row) => row.pdf_status === "processing")) return "processing";
  return "pending";
}

interface RenderCountRow extends RenderRow {
  pdf_total: number;
  pdf_processed: number;
}

/**
 * Render's counters. A row that has not finished only contributes the emails
 * Render has actually counted, so the total stays 0 (the tile reads "Waiting")
 * until Render starts instead of showing one placeholder per PST. A finished
 * row counts as at least one, so a Render with nothing to deliver still
 * completes.
 */
export function renderProgress(rows: RenderCountRow[]): {
  done: number;
  total: number;
} {
  let done = 0;
  let total = 0;
  for (const row of rows) {
    if (row.pdf_status === "completed") {
      const size = Math.max(row.pdf_total, 1);
      done += size;
      total += size;
    } else {
      done += row.pdf_processed;
      total += row.pdf_total;
    }
  }
  return { done, total };
}
