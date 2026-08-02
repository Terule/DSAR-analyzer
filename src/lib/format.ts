export function getRelativePath(filepath: string): string {
  if (!filepath) return "";
  // Managed cases use the configured staging root (normally `/data/Staging`),
  // not the legacy `staging-area` directory name. Resolve it first so the
  // corresponding output root is always `[case]/[request]`.
  const stagingRoot = process.env.STAGING_PATH;
  if (stagingRoot) {
    const normalizedRoot = stagingRoot.replace(/[\\/]+$/, "");
    const normalizedPath = filepath.replace(/\\/g, "/");
    const rootWithSlash = `${normalizedRoot.replace(/\\/g, "/")}/`;
    if (normalizedPath.startsWith(rootWithSlash)) {
      return normalizedPath.slice(rootWithSlash.length);
    }
  }
  return filepath.split(/staging-area[/\\]/)[1] || filepath;
}

// Groups files by their [case]/[request] unit. Both PST files
// (.../[case]/[request]/PST/x.pst) and Files batches (.../[case]/[request]/Files)
// resolve to the same "[case]/[request]" key.
export function getCaseKey(filepath: string): string {
  const rel = getRelativePath(filepath);
  const parts = rel.split(/[/\\]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] || "Root Staging Area";
}

// Masks a case name for presentation/privacy mode while preserving the
// [case]/[request] separator structure so cards stay distinguishable.
export function maskCaseName(name: string): string {
  return name.replace(/[^/\\]/g, "•");
}

export function maskSubjectInformation(name: string, email: string): string {
  const maskedName = name.replace(/[^\s]/g, "•");
  const maskedEmail = email.replace(/[^@.]/g, "•");
  return `${maskedName} · ${maskedEmail}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}
