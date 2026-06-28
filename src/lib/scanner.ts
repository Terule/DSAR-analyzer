import { scanFileMetadata as scanWithAnalyzer } from "./analyzer";

/**
 * Legacy compatibility shim.
 *
 * The project no longer uses `pst-extractor`; metadata scanning now follows
 * the analyzer flow (readpst-based pipeline). Keep this file as a thin wrapper
 * so older imports remain valid.
 */
export async function scanFileMetadata(fileId: string): Promise<void> {
  await scanWithAnalyzer(fileId);
}
