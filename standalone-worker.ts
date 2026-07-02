/**
 * Standalone batch worker.
 * Spawned by /api/standalone as a child process so the heavy CPU work
 * (docx/xlsx parsing, hashing, HTML flattening, WeasyPrint) never runs on the
 * Next.js server event loop and cannot make it unresponsive.
 *
 * Usage: bun standalone-worker.ts <argsFilePath> <resultFilePath>
 *   argsFilePath:   JSON file with { caseName, subjectCriteria }
 *   resultFilePath: JSON file this worker writes the StandaloneBatchResult to
 */

import fs from "node:fs";
import {
  runStandaloneBatch,
  type StandaloneBatchParams,
  type StandaloneBatchResult,
} from "./src/lib/standalone-processor";

async function main() {
  const argsFilePath = process.argv[2];
  const resultFilePath = process.argv[3];

  if (!argsFilePath || !resultFilePath) {
    console.error(
      "[standalone-worker] Missing arguments. Usage: bun standalone-worker.ts <argsFile> <resultFile>",
    );
    process.exit(2);
  }

  let result: StandaloneBatchResult;

  try {
    const params = JSON.parse(
      fs.readFileSync(argsFilePath, "utf-8"),
    ) as StandaloneBatchParams;

    result = await runStandaloneBatch(params);
  } catch (error) {
    result = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    fs.writeFileSync(resultFilePath, JSON.stringify(result), "utf-8");
  } catch (writeError) {
    console.error(
      "[standalone-worker] Failed to write result file:",
      writeError,
    );
    process.exit(1);
  }

  process.exit(result.success ? 0 : 1);
}

main();
