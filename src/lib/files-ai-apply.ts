import fs from "node:fs";
import path from "node:path";

export interface DiscardInput {
  relPath: string;
  reason: string;
}

const SAFE_REL_PATH = /^(Documents|Messages)\/[^/\\]+$/;

function assertSafe(relPath: string): void {
  if (
    !SAFE_REL_PATH.test(relPath) ||
    relPath.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error(`Unsafe path for a Files AI discard: ${relPath}`);
  }
}

/**
 * Moves discarded deliverables to `<requestOutputDir>/Discarded/<relPath>`.
 * Idempotent: a file that is already in `Discarded/` counts as already moved,
 * so a re-run after an interrupted apply neither fails nor double-counts.
 */
export function applyDiscards(input: {
  requestOutputDir: string;
  discards: DiscardInput[];
}): { moved: number; alreadyMoved: number } {
  let moved = 0;
  let alreadyMoved = 0;
  for (const discard of input.discards) {
    assertSafe(discard.relPath);
    const source = path.join(input.requestOutputDir, discard.relPath);
    const target = path.join(
      input.requestOutputDir,
      "Discarded",
      discard.relPath,
    );
    if (fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      moved++;
    } else if (fs.existsSync(target)) {
      alreadyMoved++;
    }
  }
  return { moved, alreadyMoved };
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Writes `Discarded/verdicts.csv`, replacing any earlier copy. */
export function writeVerdictsCsv(input: {
  requestOutputDir: string;
  rows: Array<{ relPath: string; verdict: string; reason: string }>;
}): string {
  const directory = path.join(input.requestOutputDir, "Discarded");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "verdicts.csv");
  const lines = [
    "file,verdict,reason",
    ...input.rows.map(
      (row) =>
        `${csvCell(row.relPath)},${csvCell(row.verdict)},${csvCell(row.reason)}`,
    ),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
