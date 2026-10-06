import fs from "node:fs";
import path from "node:path";

const NO_LOGS = "No worker logs available.";

/** Appends `chunk` to `current`, keeping only the last `max` characters. */
export function keepTail(current: string, chunk: string, max: number): string {
  const joined = current + chunk;
  return joined.length > max ? joined.slice(joined.length - max) : joined;
}

/**
 * Where a one-shot worker mirrors its own output. Workers run with
 * AutoRemove, so the container (and its Docker logs) is gone by the time the
 * dispatcher reaps the job; this file on the shared logs mount survives.
 * It is separate from `<jobId>.log`, which the dispatcher writes.
 */
export function workerLogPath(root: string, jobId: string): string {
  return path.join(root, "logs", "jobs", `${jobId}.worker.log`);
}

/** Container logs when Docker still has them, otherwise the worker's file. */
export async function resolveJobLogs(
  containerLogs: () => Promise<string>,
  workerLogFile: string,
): Promise<string> {
  const fromContainer = await containerLogs().catch(() => "");
  if (fromContainer.trim()) return fromContainer;
  try {
    const fromFile = fs.readFileSync(workerLogFile, "utf8");
    if (fromFile.trim()) return fromFile;
  } catch {
    // No file: the worker never started or could not write it.
  }
  return NO_LOGS;
}
