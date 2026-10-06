import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { openWorkerLogFd } from "./worker-log";

let workerRunning = false;
let workerChild: ChildProcess | null = null;

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
  workerChild = child;
  child.once("exit", () => {
    workerRunning = false;
    workerChild = null;
  });
  child.unref();
}

/** Stops the worker this process started, so the next start launches a new one. */
export function stopSharePointArtifactWorker(): void {
  workerChild?.kill("SIGTERM");
}
