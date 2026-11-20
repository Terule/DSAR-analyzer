/**
 * Layer 4 of the image rules (docs/pipeline-refactor.md, 4.4): the same picture
 * attached to many emails is a signature, a logo or a banner, not evidence.
 * Counted once per request before Render starts, over the emails about to be
 * rendered, so a logo that the shape and name rules missed is still caught.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { simpleParser } from "mailparser";
import { isImageFilename } from "./image-rules";

/** An identical image in at least this many different emails recurs. */
export const RECURRENCE_MIN_EMAILS = Number(
  process.env.IMAGE_RECURRENCE_MIN_EMAILS || 4,
);

export function imageHash(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** A cheap look at the raw message: parse only what may carry an image. */
const MAY_HAVE_IMAGE_RE =
  /content-type:\s*image\/|filename\*?=[^\r\n]*\.(?:png|jpe?g|gif|webp)\b/i;

/** Image hash -> number of different emails that carry it. */
export async function countImageRecurrence(
  emlPaths: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let done = 0;
  for (const file of emlPaths) {
    done++;
    if (done % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
    let raw: Buffer;
    try {
      raw = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (!MAY_HAVE_IMAGE_RE.test(raw.toString("latin1"))) continue;
    try {
      const parsed = await simpleParser(raw);
      const hashes = new Set<string>();
      for (const attachment of parsed.attachments ?? []) {
        const name = attachment.filename || path.basename(file);
        const isImage =
          (attachment.contentType || "").toLowerCase().startsWith("image/") ||
          isImageFilename(name);
        if (isImage && attachment.content) {
          hashes.add(imageHash(attachment.content));
        }
      }
      for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    } catch {
      // An unreadable message simply adds nothing to the counts.
    }
  }
  return counts;
}

/** True when the attachment is already part of the email PDF: the body references it by Content-ID. */
export function isEmbeddedInBody(
  attachment: { contentId?: string; cid?: string; related?: boolean },
  bodyHtml: string | undefined,
): boolean {
  if (attachment.related === true) return true;
  const cid = (attachment.contentId || attachment.cid || "").replace(
    /[<>]/g,
    "",
  );
  if (!cid || !bodyHtml) return false;
  return bodyHtml.toLowerCase().includes(`cid:${cid.toLowerCase()}`);
}
