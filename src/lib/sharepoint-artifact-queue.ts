import { spawn } from "node:child_process";
import path from "node:path";
import { openWorkerLogFd } from "./worker-log";

let workerRunning = false;

export function startSharePointArtifactWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  const workerPath = path.resolve(
    process.cwd(),
    "scripts/workers/sharepoint-artifact-worker.ts",
  );
  const logFd = openWorkerLogFd("sharepoint-artifact-worker");
  const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.once("exit", () => {
    workerRunning = false;
  });
  child.unref();
}
