import fs from "node:fs";
import path from "node:path";
import { isUnfinalizedName } from "./request-waves";

export interface FilesAiCandidate {
  /** Path relative to the request output folder, e.g. `Documents/Document <hash>.pdf`. */
  relPath: string;
  kind: "Document" | "Message";
  fileName: string;
  absPath: string;
}

function listFolder(
  dir: string,
  kind: "Document" | "Message",
  folderName: "Documents" | "Messages",
): FilesAiCandidate[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith(".") &&
        entry.name.toLowerCase().endsWith(".pdf") &&
        isUnfinalizedName(entry.name, kind),
    )
    .map((entry) => ({
      relPath: `${folderName}/${entry.name}`,
      kind,
      fileName: entry.name,
      absPath: path.join(dir, entry.name),
    }))
    .sort((a, b) =>
      a.fileName.localeCompare(b.fileName, undefined, { numeric: true }),
    );
}

/**
 * This wave's converted PDFs that have not been numbered yet. Files finalized
 * by an earlier wave and the `Unconverted/` originals are never candidates.
 */
export function listFilesAiCandidates(dirs: {
  messagesDir: string;
  documentsDir: string;
}): FilesAiCandidate[] {
  return [
    ...listFolder(dirs.documentsDir, "Document", "Documents"),
    ...listFolder(dirs.messagesDir, "Message", "Messages"),
  ];
}

/**
 * pdf-parse writes `-- 1 of 3 --` between pages. A PDF made from a picture has
 * no other text, so the markers alone made it look like a document with
 * content, and the model discarded it as "empty" instead of it going to a
 * person. Strip them before anything asks whether there is text.
 */
export function stripPageMarkers(text: string): string {
  return text
    .replace(/^[ \t]*--[ \t]*\d+[ \t]*(?:of[ \t]*)?\d*[ \t]*--[ \t]*$/gim, "")
    .trim();
}

/** Text of the first pages of a PDF plus its total page count. */
export async function readPdfSample(
  absPath: string,
  maxPages = 12,
): Promise<{ text: string; totalPages: number }> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: fs.readFileSync(absPath) });
    try {
      const result = await parser.getText({ first: maxPages });
      return {
        text: stripPageMarkers(result.text ?? ""),
        totalPages: result.total ?? 0,
      };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch {
    return { text: "", totalPages: 0 };
  }
}

/** Text of the first pages of a PDF, or "" when it cannot be read. */
export async function readPdfText(
  absPath: string,
  maxPages = 12,
): Promise<string> {
  return (await readPdfSample(absPath, maxPages)).text;
}
