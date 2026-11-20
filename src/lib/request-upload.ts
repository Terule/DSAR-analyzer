import fs from "node:fs";
import path from "node:path";
import { getCaseKey } from "./format";
import { getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";
import { isDeliverablePath } from "./sharepoint-artifact-outbox";

export interface UploadPreview {
  /** Why the upload is not offered, or null. */
  blocked: string | null;
  destination: string;
  files: number;
  bytes: number;
  alreadyUploaded: number;
  /** First processed row of the request: the owner of the queued artifacts. */
  fileId: string | null;
  paths: string[];
}

/**
 * What a manual SharePoint upload of one request would send: the deliverable
 * folders only (`Emails`, `Messages`, `Documents`, `For Human Review`), never
 * `Discarded/` or `Unconverted/`. Client cases are delivered to OneTrust and
 * never uploaded to SharePoint.
 */
export async function previewRequestUpload(
  requestId: string,
): Promise<UploadPreview | null> {
  const request = await prisma.caseRequest.findUnique({
    where: { id: requestId },
    select: {
      name: true,
      case: { select: { name: true, case_type: true } },
      processed_files: {
        select: { id: true, filepath: true },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!request) return null;
  const settings = await getAiBatchSettings();
  const folder = settings.sharePointFolderPath.replace(/^\/+|\/+$/g, "");
  const destination = [
    "SharePoint",
    ...(folder ? folder.split("/") : []),
    request.case.name,
    request.name,
  ].join(" › ");
  const empty = {
    destination,
    files: 0,
    bytes: 0,
    alreadyUploaded: 0,
    fileId: null,
    paths: [],
  };
  if (request.case.case_type === "client") {
    return {
      ...empty,
      blocked:
        "Client cases are delivered to OneTrust and are never uploaded to SharePoint.",
    };
  }
  const outputRoot = process.env.EXTRACTED_PATH;
  const rows = request.processed_files.filter((row) => row.filepath);
  if (!outputRoot || rows.length === 0) {
    return { ...empty, blocked: "This request has no output to upload yet." };
  }
  const root = path.join(outputRoot, getCaseKey(rows[0].filepath as string));
  const paths = fs.existsSync(root)
    ? fs
        .readdirSync(root, { recursive: true })
        .map((entry) => path.join(root, String(entry)))
        .filter((entry) => {
          if (!isDeliverablePath(path.relative(root, entry))) return false;
          try {
            return fs.statSync(entry).isFile();
          } catch {
            return false;
          }
        })
    : [];
  if (paths.length === 0) {
    return { ...empty, blocked: "There are no delivered files to upload yet." };
  }
  const bytes = paths.reduce((sum, entry) => sum + fs.statSync(entry).size, 0);
  const done = await prisma.sharePointUploadArtifact.count({
    where: { local_path: { in: paths }, status: "completed" },
  });
  return {
    blocked: null,
    destination,
    files: paths.length,
    bytes,
    alreadyUploaded: done,
    fileId: rows[0].id,
    paths,
  };
}
