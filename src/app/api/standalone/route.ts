import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import type { StandaloneBatchResult } from "@/lib/standalone-processor";

export const dynamic = "force-dynamic";

// Run the batch in a child process. Awaiting a child process is a non-blocking
// I/O wait, so the Next.js server event loop stays responsive even while a large
// batch is being processed (all heavy CPU work happens in the worker process).
function runWorker(
  argsFilePath: string,
  resultFilePath: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const workerPath = path.resolve(process.cwd(), "standalone-worker.ts");
    const child = spawn("bun", [workerPath, argsFilePath, resultFilePath], {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

export async function POST(request: Request) {
  let tmpDir: string | undefined;

  try {
    const { caseName, subjectCriteria } = await request.json();

    if (!caseName || !subjectCriteria?.name) {
      return NextResponse.json(
        { success: false, error: "Missing caseName or subjectCriteria.name" },
        { status: 400 },
      );
    }

    // Stage job args and result files for the worker process.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-job-"));
    const argsFilePath = path.join(tmpDir, "args.json");
    const resultFilePath = path.join(
      tmpDir,
      `result-${crypto.randomBytes(4).toString("hex")}.json`,
    );

    fs.writeFileSync(
      argsFilePath,
      JSON.stringify({ caseName, subjectCriteria }),
      "utf-8",
    );

    const { code, stderr } = await runWorker(argsFilePath, resultFilePath);

    if (!fs.existsSync(resultFilePath)) {
      console.error(
        `[Standalone Engine] Worker exited (code ${code}) without a result. stderr: ${stderr}`,
      );
      return NextResponse.json(
        {
          success: false,
          error: "Standalone worker failed before producing a result.",
        },
        { status: 500 },
      );
    }

    const result = JSON.parse(
      fs.readFileSync(resultFilePath, "utf-8"),
    ) as StandaloneBatchResult;

    return NextResponse.json(result, {
      status: result.success ? 200 : 500,
    });
  } catch (error) {
    console.error("API route /api/standalone encountered an error:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
