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
  return moveToFolder(input.requestOutputDir, DISCARDED_DIR, input.discards);
}

/** Held back from numbering, delivered separately for a person to decide. */
export const HUMAN_REVIEW_DIR = "For Human Review";
export const DISCARDED_DIR = "Discarded";

/** Moves files the AI could not settle to `For Human Review/<relPath>`. */
export function applyReviews(input: {
  requestOutputDir: string;
  reviews: DiscardInput[];
}): { moved: number; alreadyMoved: number } {
  return moveToFolder(input.requestOutputDir, HUMAN_REVIEW_DIR, input.reviews);
}

function moveToFolder(
  requestOutputDir: string,
  folder: string,
  items: DiscardInput[],
): { moved: number; alreadyMoved: number } {
  let moved = 0;
  let alreadyMoved = 0;
  for (const discard of items) {
    assertSafe(discard.relPath);
    const source = path.join(requestOutputDir, discard.relPath);
    const target = path.join(requestOutputDir, folder, discard.relPath);
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

/** Writes `For Human Review/review.csv` (file, reason) for the whole request. */
export function writeReviewCsv(input: {
  requestOutputDir: string;
  rows: Array<{ relPath: string; reason: string }>;
}): string {
  const directory = path.join(input.requestOutputDir, HUMAN_REVIEW_DIR);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "review.csv");
  const lines = [
    "file,reason",
    ...input.rows.map(
      (row) => `${csvCell(row.relPath)},${csvCell(row.reason)}`,
    ),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** Files delivered for human review (the CSV included), for the upload queue. */
export function listHumanReviewDeliverables(
  requestOutputDir: string,
): string[] {
  const root = path.join(requestOutputDir, HUMAN_REVIEW_DIR);
  const found: string[] = [];
  const walk = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  walk(root);
  return found;
}
