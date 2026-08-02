import { spawn } from "node:child_process";
import path from "node:path";
import { openWorkerLogFd } from "./worker-log";

/**
 * Uploads are deliberately detached from the HTTP request. A browser sleeping
 * or disconnecting must not interrupt a multi-hour SharePoint transfer.
 */
export function startSharePointUploadWorker(fileIds: string[]): void {
  const workerPath = path.resolve(
    process.cwd(),
    "scripts/workers/sharepoint-upload-worker.ts",
  );
  const logFd = openWorkerLogFd("sharepoint-upload-worker");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, JSON.stringify(fileIds)],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
}
