import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.env.EXTRACTED_PATH || "/data/Results";
const apply = process.argv.includes("--apply");

function normalizeSequence(folder: string, prefix: string): number {
  if (!fs.existsSync(folder)) return 0;
  const files = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const expression = new RegExp(`^${prefix} (\\d+)(\\.[^.]+)$`);
  const numbered = files
    .map((name) => ({ name, match: name.match(expression) }))
    .filter(
      (item): item is { name: string; match: RegExpMatchArray } =>
        item.match !== null,
    )
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (numbered.length === 0) return 0;

  const width = String(numbered.length).length;
  const primaryChanges = numbered
    .map(({ name, match }, index) => ({
      from: name,
      to: `${prefix} ${String(index + 1).padStart(width, "0")}${match[2]}`,
    }))
    .filter((change) => change.from !== change.to);
  // Email attachments keep their parent email number in the filename. Rename
  // that prefix alongside the parent PDF without changing attachment order.
  const relatedChanges = primaryChanges.flatMap((change) => {
    const fromBase = path.parse(change.from).name;
    const toBase = path.parse(change.to).name;
    return files
      .filter((name) => name.startsWith(`${fromBase} `))
      .map((name) => ({
        from: name,
        to: `${toBase}${name.slice(fromBase.length)}`,
      }));
  });
  const changes = [...primaryChanges, ...relatedChanges];
  if (changes.length === 0) return 0;

  const sourceNames = new Set(changes.map((change) => change.from));
  for (const change of changes) {
    if (
      fs.existsSync(path.join(folder, change.to)) &&
      !sourceNames.has(change.to)
    ) {
      throw new Error(`Refusing to overwrite existing file: ${change.to}`);
    }
  }
  for (const change of changes) {
    console.log(
      `${apply ? "Renaming" : "Would rename"}: ${change.from} → ${change.to}`,
    );
  }
  if (!apply) return changes.length;

  const token = crypto.randomUUID();
  const staged = changes.map((change, index) => ({
    ...change,
    temporary: `.__aida-rename-${token}-${index}`,
  }));
  for (const change of staged) {
    fs.renameSync(
      path.join(folder, change.from),
      path.join(folder, change.temporary),
    );
  }
  for (const change of staged) {
    fs.renameSync(
      path.join(folder, change.temporary),
      path.join(folder, change.to),
    );
  }
  return changes.length;
}

function normalizeAttachmentSequences(folder: string): number {
  const files = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const groups = new Map<
    string,
    Array<{ name: string; number: number; extension: string }>
  >();
  for (const name of files) {
    const match = name.match(
      /^(Email \d+|Warning \d+) Attachment (\d+)(\.[^.]+)$/,
    );
    if (!match) continue;
    const entries = groups.get(match[1]) || [];
    entries.push({ name, number: Number(match[2]), extension: match[3] });
    groups.set(match[1], entries);
  }
  let changed = 0;
  for (const [base, entries] of groups) {
    entries.sort((a, b) => a.number - b.number);
    const width = String(entries.length).length;
    const staged = entries
      .map((entry, index) => ({
        from: entry.name,
        to: `${base} Attachment ${String(index + 1).padStart(width, "0")}${entry.extension}`,
        temporary: `.__aida-attachment-${crypto.randomUUID()}`,
      }))
      .filter((entry) => entry.from !== entry.to);
    for (const entry of staged) {
      console.log(
        `${apply ? "Renaming" : "Would rename"}: ${entry.from} → ${entry.to}`,
      );
    }
    if (apply) {
      for (const entry of staged) {
        fs.renameSync(
          path.join(folder, entry.from),
          path.join(folder, entry.temporary),
        );
      }
      for (const entry of staged) {
        fs.renameSync(
          path.join(folder, entry.temporary),
          path.join(folder, entry.to),
        );
      }
    }
    changed += staged.length;
  }
  return changed;
}

function walk(current: string): number {
  let renamed = 0;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(current, entry.name);
    if (entry.name === "Documents")
      renamed += normalizeSequence(directory, "Document");
    else if (entry.name === "Messages")
      renamed += normalizeSequence(directory, "Message");
    else if (entry.name === "Emails") {
      renamed += normalizeSequence(directory, "Email");
      renamed += normalizeSequence(directory, "Warning");
      renamed += normalizeAttachmentSequences(directory);
    }
    renamed += walk(directory);
  }
  return renamed;
}

if (!fs.existsSync(root))
  throw new Error(`Deliverables root does not exist: ${root}`);
const changed = walk(root);
console.log(`${apply ? "Renamed" : "Found"} ${changed} deliverable file(s).`);
