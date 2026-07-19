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
  let relativeDirectory = "";
  if (input.filepath.startsWith(input.stagingPath)) {
    relativeDirectory = path.dirname(
      path.relative(input.stagingPath, input.filepath),
    );
  } else {
    relativeDirectory = input.fileId;
  }

  if (relativeDirectory === "." || relativeDirectory === "") {
    relativeDirectory = path.parse(input.filepath).name;
  }

  const extractionKey = crypto
    .createHash("sha256")
    .update(`${input.fileId}:${input.filepath}`)
    .digest("hex")
    .substring(0, 12);
  // PST artifacts are internal working data, not case deliverables. Keep them
  // under a dot-folder so Finder only shows Emails/Documents/Messages.
  const caseFolder = path.join(
    input.extractedPath,
    path.dirname(relativeDirectory),
    ".work",
    path.basename(relativeDirectory),
  );

  return {
    caseFolder,
    rawEmlFolder: path.join(caseFolder, `.pst-eml-${extractionKey}`),
    sourceRelativePath: relativeDirectory,
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
