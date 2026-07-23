import crypto from "node:crypto";
import path from "node:path";

/**
 * Paths produced by Parse and consumed by Extract for one PST. Keeping this
 * calculation in one place prevents a producer/consumer path mismatch.
 */
export function getPstArtifactPaths(input: {
  fileId: string;
  filepath: string;
  stagingPath: string;
  extractedPath: string;
}): { caseFolder: string; rawEmlFolder: string; sourceRelativePath: string } {
  let sourceRelativePath = "";
  if (input.filepath.startsWith(input.stagingPath)) {
    sourceRelativePath = path.relative(input.stagingPath, input.filepath);
  } else {
    sourceRelativePath = input.fileId;
  }

  if (sourceRelativePath === "." || sourceRelativePath === "") {
    sourceRelativePath = path.parse(input.filepath).name;
  }

  const sourceParts = sourceRelativePath.split(/[\\/]/).filter(Boolean);
  // A request is always the first two staging levels: `[case]/[request]`.
  // Deeper eDiscovery export folders group input files but do not split the
  // request's shared Parse → Extract → AI → Render working set.
  const requestRelativePath =
    sourceParts.length >= 2
      ? path.join(sourceParts[0], sourceParts[1])
      : path.dirname(sourceRelativePath);

  const extractionKey = crypto
    .createHash("sha256")
    .update(`${input.fileId}:${input.filepath}`)
    .digest("hex")
    .substring(0, 12);
  // PST artifacts are internal working data, not case deliverables. Keep them
  // under a dot-folder so Finder only shows Emails/Documents/Messages.
  const caseFolder = path.join(
    input.extractedPath,
    requestRelativePath,
    ".work",
    "PST",
  );

  return {
    caseFolder,
    rawEmlFolder: path.join(caseFolder, `.pst-eml-${extractionKey}`),
    sourceRelativePath,
  };
}

export function getPstWorkFolder(input: {
  fileId: string;
  filepath: string;
  stagingPath: string;
  extractedPath: string;
}): string {
  return getPstArtifactPaths(input).caseFolder;
}
