/**
 * "Scan input folder": finds what was delivered under the staging root as
 * `[case]/[request]/{PST,Files}` and turns it into a case with its requests.
 * Only reads; creating goes through the same functions as the new request dialog.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  addManagedRequest,
  createManagedCase,
  type RequestScope,
  summary,
} from "./cases";
import { isPstFilename } from "./file-types";
import { prisma } from "./prisma";

const STAGING_ROOT = "/data/Staging";

export interface FoundRequest {
  name: string;
  pstCount: number;
  pstBytes: number;
  fileCount: number;
  fileBytes: number;
  scope: RequestScope | null;
  /** A request of this name already exists in the case. */
  existing: boolean;
}

/** The scope a request folder calls for, or null when it holds nothing. */
export function scopeForContent(
  pstCount: number,
  fileCount: number,
): RequestScope | null {
  if (pstCount > 0 && fileCount > 0) return "both";
  if (pstCount > 0) return "mail";
  if (fileCount > 0) return "files";
  return null;
}

/** A single folder name, never a path: the scan must stay under the staging root. */
export function safeFolderName(value: string): string {
  const name = value.trim();
  if (!name || name.startsWith(".") || /[\\/\0]/.test(name)) {
    throw new Error("Choose a folder inside the input folder.");
  }
  return name;
}

async function subfolders(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) =>
        left.localeCompare(right, "en", { numeric: true }),
      );
  } catch {
    return [];
  }
}

export async function listInputFolders(): Promise<
  Array<{ name: string; inCase: boolean }>
> {
  const names = await subfolders(STAGING_ROOT);
  const cases = await prisma.managedCase.findMany({
    where: { name: { in: names } },
    select: { name: true },
  });
  const known = new Set(cases.map((item) => item.name));
  return names.map((name) => ({ name, inCase: known.has(name) }));
}

export async function scanInputFolder(folder: string): Promise<FoundRequest[]> {
  const name = safeFolderName(folder);
  const parent = await prisma.managedCase.findUnique({
    where: { name },
    select: { requests: { select: { name: true } } },
  });
  const existing = new Set(parent?.requests.map((request) => request.name));
  const found: FoundRequest[] = [];
  for (const request of await subfolders(path.join(STAGING_ROOT, name))) {
    const base = path.join(STAGING_ROOT, name, request);
    const pst = await summary(path.join(base, "PST"), isPstFilename);
    const files = await summary(
      path.join(base, "Files"),
      (file) => !file.startsWith(".") && !file.toLowerCase().endsWith(".json"),
    );
    found.push({
      name: request,
      pstCount: pst.count,
      pstBytes: pst.size,
      fileCount: files.count,
      fileBytes: files.size,
      scope: scopeForContent(pst.count, files.count),
      existing: existing.has(request),
    });
  }
  return found;
}

/** Creates the case when it does not exist, then every found request that is new. */
export async function addScannedRequests(input: {
  folder: string;
  caseType?: string;
}): Promise<{ caseId: string; added: string[] }> {
  const name = safeFolderName(input.folder);
  const found = await scanInputFolder(name);
  const toAdd = found.filter((request) => !request.existing && request.scope);
  if (toAdd.length === 0) {
    throw new Error("Nothing new to add in this folder.");
  }
  let parent = await prisma.managedCase.findUnique({
    where: { name },
    select: { id: true, case_type: true },
  });
  if (!parent) {
    const created = await createManagedCase({
      name,
      caseType: input.caseType,
    });
    parent = { id: created.id, case_type: created.case_type };
  }
  // A client case holds one request.
  const wanted = parent.case_type === "client" ? toAdd.slice(0, 1) : toAdd;
  const added: string[] = [];
  for (const request of wanted) {
    if (!request.scope) continue;
    await addManagedRequest(parent.id, {
      name: request.name,
      scope: request.scope,
    });
    added.push(request.name);
  }
  return { caseId: parent.id, added };
}
