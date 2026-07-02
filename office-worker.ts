/**
 * Office conversion worker (thread).
 * Runs the CPU-heavy, SYNCHRONOUS Office parsing (xlsx.read / mammoth) off the
 * main standalone worker's event loop. `xlsx.read()` in particular is fully
 * synchronous and would otherwise block the process so hard that in-process
 * timeouts can never fire (observed freeze on large .xlsx files).
 *
 * Spawned by src/lib/standalone-processor.ts via `new Worker(...)`.
 */

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { processDocxToPdf, processExcelToPdf } from "./src/lib/converter";

interface OfficeWorkerData {
  kind: "docx" | "excel";
  filePath: string;
  outputPath: string;
  criteria: string[];
  docTitle: string;
}

function isLikelyPasswordProtectedOffice(buffer: Buffer): boolean {
  // OOXML encrypted containers usually include this marker.
  return buffer.includes(Buffer.from("EncryptedPackage", "utf-8"));
}

async function main() {
  const { kind, filePath, outputPath, criteria, docTitle } =
    workerData as OfficeWorkerData;

  try {
    const buffer = fs.readFileSync(filePath);

    if (isLikelyPasswordProtectedOffice(buffer)) {
      parentPort?.postMessage({
        ok: true,
        success: false,
        passwordProtected: true,
      });
      return;
    }

    const success =
      kind === "docx"
        ? await processDocxToPdf(buffer, outputPath, criteria, docTitle)
        : await processExcelToPdf(buffer, outputPath, criteria, docTitle);

    parentPort?.postMessage({ ok: true, success, passwordProtected: false });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

main();
