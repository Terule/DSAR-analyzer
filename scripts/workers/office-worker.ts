/**
 * Office conversion worker (thread).
 * Runs the CPU-heavy, SYNCHRONOUS Office parsing (xlsx.read / mammoth) off the
 * main standalone worker's event loop. `xlsx.read()` in particular is fully
 * synchronous and would otherwise block the process so hard that in-process
 * timeouts can never fire (observed freeze on large .xlsx files).
 *
 * Spawned by src/lib/standalone-processor.ts via `new Worker(...)`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import * as xlsx from "xlsx";
import { processDocxToPdf, processExcelToPdf } from "../../src/lib/converter";

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

/** A stable fingerprint of what an Excel user can see, ignoring package metadata. */
function excelContentKey(buffer: Buffer): string {
  const workbook = xlsx.read(buffer, { type: "buffer", cellText: true });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = sheet?.["!ref"]
      ? xlsx.utils.decode_range(sheet["!ref"])
      : null;
    const cells: string[][] = [];
    if (range) {
      for (let row = range.s.r; row <= range.e.r; row++) {
        const values: string[] = [];
        for (let column = range.s.c; column <= range.e.c; column++) {
          const cell = sheet[xlsx.utils.encode_cell({ r: row, c: column })];
          values.push(cell ? xlsx.utils.format_cell(cell).trim() : "");
        }
        cells.push(values);
      }
    }
    return { name, cells };
  });
  return `office:${crypto
    .createHash("sha256")
    .update(JSON.stringify(sheets))
    .digest("hex")}`;
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

    const contentKey = kind === "excel" ? excelContentKey(buffer) : undefined;
    const success =
      kind === "docx"
        ? await processDocxToPdf(buffer, outputPath, criteria, docTitle)
        : await processExcelToPdf(buffer, outputPath, criteria, docTitle);

    parentPort?.postMessage({
      ok: true,
      success,
      passwordProtected: false,
      contentKey,
    });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

main();
