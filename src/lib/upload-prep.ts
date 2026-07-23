import fs from "node:fs";
import path from "node:path";

/** Remove Finder metadata from a completed deliverable tree before upload. */
export function removeDsStoreFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;

  let removed = 0;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.name === ".DS_Store") {
        fs.rmSync(fullPath, { force: true });
        removed++;
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(fullPath);
      }
    }
  };

  visit(root);
  return removed;
}
