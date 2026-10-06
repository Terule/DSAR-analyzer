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
