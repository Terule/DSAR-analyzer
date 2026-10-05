import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type WaveScope = "mail" | "files" | "both";
export type NumberedPrefix = "Email" | "Warning";

const SCOPES: readonly string[] = ["mail", "files", "both"];

/** Widens two request scopes into the smallest scope covering both. */
export function unionScope(left: string, right: string): WaveScope {
  if (!SCOPES.includes(left) || !SCOPES.includes(right)) {
    throw new Error("Scope must be mail, files, or both.");
  }
  const mail = left !== "files" || right !== "files";
  const files = left !== "mail" || right !== "mail";
  return mail && files ? "both" : mail ? "mail" : "files";
}

/**
 * Source-row id. Wave 1 keeps the historical formula so existing data is
 * untouched; later waves include the wave number so an identically named PST
 * in a new wave can never collide with the earlier one.
 */
export function waveRowId(
  requestId: string,
  wave: number,
  fullPath: string,
): string {
  const seed =
    wave <= 1
      ? `${requestId}:${fullPath}`
      : `${requestId}:w${wave}:${fullPath}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function numberPattern(prefix: NumberedPrefix): RegExp {
  return new RegExp(`^${prefix} (\\d+)\\b`);
}

/** Highest `Email N` / `Warning N` among directory entry names (0 if none). */
export function highestNumber(names: string[], prefix: NumberedPrefix): number {
  const pattern = numberPattern(prefix);
  let highest = 0;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Zero-pad width for the final number, never narrower than files already
 * delivered. Existing files are never renamed when the width grows.
 */
export function numberWidth(
  names: string[],
  prefix: NumberedPrefix,
  finalNumber: number,
): number {
  const pattern = numberPattern(prefix);
  let width = String(Math.max(1, finalNumber)).length;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) width = Math.max(width, match[1].length);
  }
  return width;
}

export function formatNumber(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export interface PruneCandidate {
  id: string;
  filepath: string | null;
  case_request_id: string | null;
  kind: string;
  pdf_status: string;
  files_status: string;
}

/**
 * A managed request's source row that finished rendering is kept even when its
 * source file is gone: its email hashes are the dedup memory for later waves.
 */
export function isRenderedSourceRow(row: PruneCandidate): boolean {
  if (!row.case_request_id) return false;
  return row.kind === "files"
    ? row.files_status === "completed"
    : row.pdf_status === "completed";
}

export function rowsToPrune<T extends PruneCandidate>(
  rows: T[],
  exists: (filepath: string) => boolean,
): T[] {
  return rows.filter(
    (row) =>
      (!row.filepath || !exists(row.filepath)) && !isRenderedSourceRow(row),
  );
}

/** Removes top-level `<prefix> N…` entries numbered above `base`. */
export function removeOutputAbove(
  directory: string,
  prefix: NumberedPrefix,
  base: number,
): number {
  if (!fs.existsSync(directory)) return 0;
  const pattern = numberPattern(prefix);
  let removed = 0;
  for (const name of fs.readdirSync(directory)) {
    const match = pattern.exec(name);
    if (match && Number(match[1]) > base) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
