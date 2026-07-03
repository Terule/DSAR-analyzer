import fs from "node:fs";
import path from "node:path";

/**
 * Opens (append mode) a log file for a detached worker and returns its file
 * descriptor. Detached workers are spawned with `stdio: 'ignore'`, which
 * silently discards their stdout/stderr — including crash stack traces. Piping
 * their output to `logs/<name>.log` keeps failures diagnosable.
 */
export function openWorkerLogFd(name: string): number {
  const dir = path.resolve(process.cwd(), "logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return fs.openSync(path.join(dir, `${name}.log`), "a");
}
