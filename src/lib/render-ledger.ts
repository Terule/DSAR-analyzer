import fs from "node:fs";
import path from "node:path";

export interface RenderLedger {
  /** The number for this email: the one it already has, or the next free one. */
  numberFor(hash: string): number;
  /** Records an email Render skipped on purpose (it has no PDF by design). */
  markSkipped(hash: string): void;
  /** True when Render already decided to skip this email on purpose. */
  isSkipped(hash: string): boolean;
  /** Highest number handed out so far (the wave's base when none yet). */
  readonly max: number;
  /** How many distinct emails were skipped on purpose. */
  readonly skippedCount: number;
}

interface Entry {
  h: string;
  n?: number;
  skip?: true;
}

/**
 * Remembers which `Email N` number each email was given, on disk, so a retry
 * numbers an email exactly as the run that died did. Render deletes each
 * email's source file once its PDF is verified, so after a crash the retry only
 * sees the leftovers; numbering them by position would restart at 1 and collide
 * with PDFs that already exist.
 */
export function openRenderLedger(file: string, base: number): RenderLedger {
  const numbers = new Map<string, number>();
  const skipped = new Set<string>();
  let max = base;

  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue; // a half-written last line from a crash
      }
      if (typeof entry.h !== "string") continue;
      if (typeof entry.n === "number") {
        numbers.set(entry.h, entry.n);
        max = Math.max(max, entry.n);
      }
      if (entry.skip) skipped.add(entry.h);
    }
  }

  const append = (entry: Entry) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  };

  return {
    numberFor(hash) {
      const existing = numbers.get(hash);
      if (existing !== undefined) return existing;
      max += 1;
      numbers.set(hash, max);
      append({ h: hash, n: max });
      return max;
    },
    markSkipped(hash) {
      if (skipped.has(hash)) return;
      skipped.add(hash);
      append({ h: hash, skip: true });
    },
    isSkipped(hash) {
      return skipped.has(hash);
    },
    get max() {
      return max;
    },
    get skippedCount() {
      return skipped.size;
    },
  };
}
