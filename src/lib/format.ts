export function getRelativePath(filepath: string): string {
  if (!filepath) return "";
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

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}
