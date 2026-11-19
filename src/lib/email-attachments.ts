import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ArchiveLimits, expandArchives } from "./archive-expander";
import { isPasswordProtectedBuffer } from "./password-protection";

/** An attachment the pipeline did not deliver, with the rule that dropped it. */
export interface AttachmentDrop {
  filename: string;
  rule: "unsupported_type" | "password" | "zip_error";
  reason: string;
}

export interface AttachmentFile {
  filename: string;
  content: Buffer;
}

/** The only attachment types the pipeline can turn into a reviewable PDF. */
export const CONVERTIBLE_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".csv",
  ".txt",
]);

// An attachment is one email's baggage, not a staged Files drop: keep its zips
// small and shallow.
const ATTACHMENT_ZIP_LIMITS: ArchiveLimits = {
  maxDepth: 2,
  maxEntries: 2_000,
  maxBytes: 2 * 1024 ** 3,
  timeoutMs: 60_000,
};

function walkFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * Flattens an email's attachments into the files that may be delivered.
 *  - a password-protected file is dropped, in every case type;
 *  - a zip is expanded (bounded), never delivered itself, and each entry is
 *    judged like any other attachment; an encrypted, corrupt or oversized zip
 *    contributes nothing;
 *  - anything the pipeline cannot convert is dropped, so nothing leaves the
 *    mailbox unfiltered.
 */
export async function flattenAttachments(
  attachments: Array<{
    filename?: string;
    content?: Buffer | Uint8Array | string;
  }>,
  log: (message: string) => void = console.log,
  onDrop?: (drop: AttachmentDrop) => void,
): Promise<AttachmentFile[]> {
  const result: AttachmentFile[] = [];
  for (const attachment of attachments) {
    if (!attachment?.content) continue;
    const filename = attachment.filename || "attachment";
    const extension = path.extname(filename).toLowerCase();
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content);

    if (
      extension !== ".zip" &&
      !CONVERTIBLE_ATTACHMENT_EXTENSIONS.has(extension)
    ) {
      log(`[Attachments] Dropped ${filename}: unsupported type.`);
      onDrop?.({
        filename,
        rule: "unsupported_type",
        reason: `Unsupported attachment type ${extension || "(none)"}.`,
      });
      continue;
    }
    if (isPasswordProtectedBuffer(content)) {
      log(`[Attachments] Dropped ${filename}: password-protected/encrypted.`);
      onDrop?.({
        filename,
        rule: "password",
        reason: "Password-protected/encrypted file.",
      });
      continue;
    }
    if (extension !== ".zip") {
      result.push({ filename, content });
      continue;
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aida-att-"));
    try {
      fs.writeFileSync(path.join(directory, "attachment.zip"), content);
      const expansion = await expandArchives(directory, {
        limits: ATTACHMENT_ZIP_LIMITS,
      });
      for (const confidential of expansion.confidential) {
        log(
          `[Attachments] Dropped ${path.basename(confidential)} inside ${filename}: password-protected.`,
        );
        onDrop?.({
          filename: `${filename}/${path.basename(confidential)}`,
          rule: "password",
          reason: "Password-protected/encrypted file inside an archive.",
        });
      }
      for (const file of walkFiles(directory)) {
        const name = path.basename(file);
        if (
          !CONVERTIBLE_ATTACHMENT_EXTENSIONS.has(
            path.extname(name).toLowerCase(),
          )
        ) {
          onDrop?.({
            filename: `${filename}/${name}`,
            rule: "unsupported_type",
            reason: `Unsupported attachment type ${path.extname(name).toLowerCase() || "(none)"} inside an archive.`,
          });
          continue;
        }
        const entry = fs.readFileSync(file);
        if (isPasswordProtectedBuffer(entry)) {
          log(
            `[Attachments] Dropped ${name} inside ${filename}: password-protected.`,
          );
          onDrop?.({
            filename: `${filename}/${name}`,
            rule: "password",
            reason: "Password-protected/encrypted file inside an archive.",
          });
          continue;
        }
        result.push({ filename: name, content: entry });
      }
    } catch (error) {
      log(`[Attachments] Could not expand ${filename}: ${error}`);
      onDrop?.({
        filename,
        rule: "zip_error",
        reason: `Could not expand the archive: ${error}`,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  return result;
}
