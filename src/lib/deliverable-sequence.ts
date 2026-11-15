import fs from "node:fs";
import path from "node:path";
import { formatNumber } from "./request-waves";

/** Top-level request folders OneTrust may receive, and the name each file carries. */
const FOLDERS = [
  { folder: "Emails", prefix: "Email", onlyNumbered: true },
  { folder: "Messages", prefix: "Message", onlyNumbered: false },
  { folder: "Documents", prefix: "Document", onlyNumbered: false },
] as const;

/**
 * Only these top-level folders of a request are sent to OneTrust. `Discarded/`
 * (confidential or irrelevant files), `For Human Review/` (client cases never
 * upload it), `Unconverted/` fallbacks, logs, working folders and every hidden
 * entry stay local.
 */
export function isOneTrustDeliverablePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return false;
  if (!FOLDERS.some((entry) => entry.folder === parts[0])) return false;
  if (parts.some((part) => part.startsWith("."))) return false;
  return parts[1] !== "Unconverted";
}

export interface RenumberResult {
  renamed: number;
}

/**
 * Makes the names in `Emails/`, `Messages/` and `Documents/` a gapless sequence
 * (`Email 01`, `Email 02`...) after someone deleted or added files by hand.
 * Existing numbers keep their order; files without a number (added manually)
 * follow them in name order. Only top-level files are touched. Subfolders such
 * as `Unconverted/` and hidden files are left alone.
 */
export function renumberDeliverables(requestRoot: string): RenumberResult {
  let renamed = 0;
  for (const { folder, prefix, onlyNumbered } of FOLDERS) {
    const directory = path.join(requestRoot, folder);
    if (!fs.existsSync(directory)) continue;
    const pattern = new RegExp(`^${prefix} (\\d+)(\\.[^.]*)?$`);
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    const numbered = entries
      .filter((name) => pattern.test(name))
      .sort(
        (a, b) =>
          Number(pattern.exec(a)?.[1]) - Number(pattern.exec(b)?.[1]) ||
          a.localeCompare(b),
      );
    const others = onlyNumbered
      ? []
      : entries
          .filter((name) => !pattern.test(name))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const ordered = [...numbered, ...others];
    const width = String(Math.max(1, ordered.length)).length;
    const targets = ordered.map(
      (name, index) =>
        `${prefix} ${formatNumber(index + 1, width)}${path.extname(name)}`,
    );
    if (ordered.every((name, index) => name === targets[index])) continue;

    const temporary = ordered.map((name, index) => {
      const temp = `.__renumber-${index}${path.extname(name)}`;
      fs.renameSync(path.join(directory, name), path.join(directory, temp));
      return temp;
    });
    for (const [index, temp] of temporary.entries()) {
      fs.renameSync(
        path.join(directory, temp),
        path.join(directory, targets[index]),
      );
      if (ordered[index] !== targets[index]) renamed++;
    }
  }
  return { renamed };
}
