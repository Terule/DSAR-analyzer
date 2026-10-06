import fs from "node:fs";
import path from "node:path";
import { highestNumber } from "./request-waves";

export interface WaveRowState {
  id: string;
  filepath: string | null;
  status: string;
  ai_status: string;
  pdf_status: string;
}

/**
 * Every PST row of the wave finished Parse/Extract, AI and Render. A failed,
 * pending or running row means the wave is not done, and an empty wave never
 * qualifies.
 */
export function allWaveRowsFinished(rows: WaveRowState[]): boolean {
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.status === "completed" &&
        row.ai_status === "completed" &&
        row.pdf_status === "completed",
    )
  );
}

/** True when `candidate` is strictly below `root` (never the root itself). */
export function isInsideDir(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function entries(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

/**
 * The wave really delivered something: an Email (or Warning) PDF numbered
 * above the wave's base exists on disk. With nothing delivered there is no
 * evidence the PSTs are no longer needed, so they must be kept.
 */
export function waveDeliveredOutput(
  emailsDir: string,
  bases: { email: number; warning: number },
): boolean {
  return (
    highestNumber(entries(emailsDir), "Email") > bases.email ||
    highestNumber(entries(path.join(emailsDir, "Warning")), "Warning") >
      bases.warning
  );
}

/**
 * Deletes the given PST files, but only those inside `pstRoot`, then removes
 * any folders that became empty below `pstRoot` (never `pstRoot` itself).
 * Returns the paths actually deleted; files already gone are ignored.
 */
export function deletePstFiles(pstRoot: string, filepaths: string[]): string[] {
  const deleted: string[] = [];
  const emptied = new Set<string>();
  for (const filepath of filepaths) {
    if (!isInsideDir(pstRoot, filepath) || !fs.existsSync(filepath)) continue;
    fs.rmSync(filepath, { force: true });
    deleted.push(filepath);
    emptied.add(path.dirname(path.resolve(filepath)));
  }
  for (const start of emptied) {
    let directory = start;
    while (isInsideDir(pstRoot, directory)) {
      if (fs.readdirSync(directory).length > 0) break;
      fs.rmdirSync(directory);
      directory = path.dirname(directory);
    }
  }
  return deleted;
}
