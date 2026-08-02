import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";

export type RequestScope = "mail" | "files" | "both";

const DEFAULT_STAGING_ROOT = "/data/Staging";
const DEFAULT_DELIVERABLES_ROOT = "/data/Results";

function segment(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    /[\\/\0]/.test(normalized)
  ) {
    throw new Error(`${label} must be a single folder name.`);
  }
  return normalized;
}

export function assertScope(value: string): RequestScope {
  if (value === "mail" || value === "files" || value === "both") return value;
  throw new Error("Scope must be mail, files, or both.");
}

async function roots() {
  return {
    staging: DEFAULT_STAGING_ROOT,
    deliverables: DEFAULT_DELIVERABLES_ROOT,
  };
}

function folderSet(scope: RequestScope) {
  return {
    inputs:
      scope === "mail"
        ? ["PST"]
        : scope === "files"
          ? ["Files"]
          : ["PST", "Files"],
    outputs:
      scope === "mail"
        ? ["Emails"]
        : scope === "files"
          ? ["Messages", "Documents"]
          : ["Emails", "Messages", "Documents"],
  };
}

async function makeRequestFolders(
  caseName: string,
  requestName: string,
  scope: RequestScope,
) {
  const base = await roots();
  const stagingPath = path.join(base.staging, caseName, requestName);
  const deliverablePath = path.join(base.deliverables, caseName, requestName);
  const folders = folderSet(scope);
  await Promise.all([
    ...folders.inputs.map((name) =>
      fs.mkdir(path.join(stagingPath, name), { recursive: true }),
    ),
    ...folders.outputs.map((name) =>
      fs.mkdir(path.join(deliverablePath, name), { recursive: true }),
    ),
  ]);
  return { stagingPath, deliverablePath };
}

export async function createManagedCase(input: { name: string }) {
  const name = segment(input.name, "Case name");
  const exists = await prisma.managedCase.findUnique({
    where: { name },
    select: { id: true },
  });
  if (exists) throw new Error("A case with this name already exists.");
  return prisma.managedCase.create({
    data: {
      id: crypto.randomUUID(),
      name,
      // Empty values deliberately represent a draft. A draft has no managed
      // folders and cannot be run until configureManagedCase completes.
      subject_name: "",
      subject_email: "",
    },
    include: { requests: true },
  });
}

export async function configureManagedCase(
  caseId: string,
  input: {
    subjectName: string;
    subjectEmail: string;
    personalEmail?: string;
    aliases?: string[];
  },
) {
  if (!input.subjectName.trim() || !input.subjectEmail.trim()) {
    throw new Error("Subject name and email are required.");
  }
  const parent = await prisma.managedCase.findUnique({
    where: { id: caseId },
    include: { requests: { select: { id: true } } },
  });
  if (!parent || parent.status !== "active")
    throw new Error("Active case not found.");
  if (parent.subject_name || parent.subject_email) {
    throw new Error("This case has already been configured.");
  }
  return prisma.managedCase.update({
    where: { id: parent.id },
    data: {
      subject_name: input.subjectName.trim(),
      subject_email: input.subjectEmail.trim(),
      subject_personal_email: input.personalEmail?.trim() || null,
      subject_aliases:
        (input.aliases || [])
          .map((item) => item.trim())
          .filter(Boolean)
          .join(", ") || null,
    },
    include: { requests: true },
  });
}

export async function addManagedRequest(
  caseId: string,
  input: { name: string; scope: string },
) {
  const requestName = segment(input.name, "Request name");
  const scope = assertScope(input.scope);
  const parent = await prisma.managedCase.findUnique({
    where: { id: caseId },
    select: { id: true, name: true, status: true },
  });
  if (!parent || parent.status !== "active")
    throw new Error("Active case not found.");
  const paths = await makeRequestFolders(parent.name, requestName, scope);
  try {
    return await prisma.caseRequest.create({
      data: {
        id: crypto.randomUUID(),
        case_id: caseId,
        name: requestName,
        scope,
        staging_path: paths.stagingPath,
        deliverable_path: paths.deliverablePath,
      },
    });
  } catch (error) {
    await Promise.all([
      fs.rm(paths.stagingPath, { recursive: true, force: true }),
      fs.rm(paths.deliverablePath, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

async function summary(directory: string, test: (name: string) => boolean) {
  let count = 0;
  let size = 0;
  async function walk(current: string) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && test(entry.name)) {
        const stat = await fs.stat(full);
        count++;
        size += stat.size;
      }
    }
  }
  await walk(directory);
  return { count, size };
}

export async function scanRequestSources(requestId: string) {
  const request = await prisma.caseRequest.findUnique({
    where: { id: requestId },
    include: { case: true },
  });
  if (!request) throw new Error("Request not found.");
  const managedRequest = request;
  if (!["ready", "failed"].includes(managedRequest.status))
    throw new Error("Request is not ready to run.");
  const scope = assertScope(managedRequest.scope);
  const pst =
    scope === "files"
      ? { count: 0, size: 0 }
      : await summary(path.join(managedRequest.staging_path, "PST"), (name) =>
          name.toLowerCase().endsWith(".pst"),
        );
  const files =
    scope === "mail"
      ? { count: 0, size: 0 }
      : await summary(
          path.join(managedRequest.staging_path, "Files"),
          (name) =>
            !name.startsWith(".") && !name.toLowerCase().endsWith(".json"),
        );
  if (
    (scope !== "files" && pst.count === 0) ||
    (scope !== "mail" && files.count === 0)
  ) {
    throw new Error(
      "Expected source files are missing from this request's staging folders.",
    );
  }
  const sources: Array<{
    id: string;
    filepath: string;
    filename: string;
    kind: string;
    bytes: number;
  }> = [];
  async function collectPst(current: string) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await collectPst(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pst")) {
        const stat = await fs.stat(full);
        sources.push({
          id: crypto
            .createHash("sha256")
            .update(`${managedRequest.id}:${full}`)
            .digest("hex")
            .slice(0, 24),
          filepath: full,
          filename: entry.name,
          kind: "pst",
          bytes: stat.size,
        });
      }
    }
  }
  if (scope !== "files")
    await collectPst(path.join(managedRequest.staging_path, "PST"));
  if (scope !== "mail")
    sources.push({
      id: crypto
        .createHash("sha256")
        .update(
          `${managedRequest.id}:${path.join(managedRequest.staging_path, "Files")}`,
        )
        .digest("hex")
        .slice(0, 24),
      filepath: path.join(managedRequest.staging_path, "Files"),
      filename: "Files",
      kind: "files",
      bytes: files.size,
    });
  await prisma.$transaction([
    prisma.processedFile.deleteMany({
      where: { case_request_id: managedRequest.id },
    }),
    ...sources.map((source) =>
      prisma.processedFile.create({
        data: {
          id: source.id,
          filename: source.filename,
          filepath: source.filepath,
          file_size_bytes: BigInt(source.bytes),
          kind: source.kind,
          status: source.kind === "files" ? "completed" : "pending",
          ai_status: source.kind === "files" ? "completed" : "pending",
          pdf_status: source.kind === "files" ? "completed" : "pending",
          files_total: source.kind === "files" ? files.count : 0,
          case_request_id: managedRequest.id,
        },
      }),
    ),
    prisma.caseRequest.update({
      where: { id: managedRequest.id },
      data: {
        pst_count: pst.count,
        pst_size_bytes: BigInt(pst.size),
        files_count: files.count,
        files_size_bytes: BigInt(files.size),
        status: "queued",
        error: null,
      },
    }),
  ]);
  return { request, sources };
}

export async function removeRequestFolders(
  requests: Array<{ staging_path: string; deliverable_path: string }>,
  includeStaging: boolean,
) {
  await Promise.all(
    requests.flatMap((request) => [
      fs.rm(request.deliverable_path, { recursive: true, force: true }),
      ...(includeStaging
        ? [fs.rm(request.staging_path, { recursive: true, force: true })]
        : []),
    ]),
  );
}

export async function refreshRequestLifecycle(
  requestId?: string,
): Promise<void> {
  const requests = await prisma.caseRequest.findMany({
    where: requestId
      ? { id: requestId }
      : { status: { in: ["running", "queued"] } },
    select: { id: true, deliverable_path: true },
  });
  for (const request of requests) {
    const rows = await prisma.processedFile.findMany({
      where: { case_request_id: request.id },
      select: {
        kind: true,
        pdf_status: true,
        files_status: true,
        total_emails: true,
        ai_approved_count: true,
      },
    });
    if (rows.length === 0) continue;
    const done = rows.every((row) =>
      row.kind === "files"
        ? ["completed", "failed"].includes(row.files_status)
        : ["completed", "failed"].includes(row.pdf_status),
    );
    const output = await summary(
      request.deliverable_path,
      (name) => !name.startsWith("."),
    );
    await prisma.caseRequest.update({
      where: { id: request.id },
      data: {
        status: done ? "completed" : "running",
        completed_at: done ? new Date() : null,
        total_emails: rows.reduce((sum, row) => sum + row.total_emails, 0),
        emails_exported: rows.reduce(
          (sum, row) => sum + row.ai_approved_count,
          0,
        ),
        deliverable_files: output.count,
        deliverable_size_bytes: BigInt(output.size),
        files_exported: output.count,
      },
    });
  }
}
