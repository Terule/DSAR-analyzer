/**
 * One definition of "this image is a signature or decoration, not content"
 * (docs/pipeline-refactor.md, section 4.4), used for images attached to emails
 * and for image files in a Files folder.
 *
 * Layers, cheapest first; the first that decides ends it:
 *  2. shape: tracking pixel, small icon, tiny file, wide low banner;
 *  3. name: `image001.png`, `Outlook-*.png`, logo, social icons, but only when
 *     the picture is also small, because Outlook names pasted screenshots
 *     `image001.png` too.
 * Not done yet: position after the signature (layer 1, needs the HTML body),
 * recurrence across emails (layer 4) and the vision model for the ambiguous ones.
 *
 * Without the vision model an image that is not clearly a signature is never
 * delivered as is: it is rendered to a PDF so that a person decides.
 */

export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/**
 * Real image formats the pipeline cannot read or render. They are never
 * dropped for that reason: the original goes to a person.
 */
export const UNRENDERABLE_IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);

const UNRENDERABLE_IMAGE_TYPE_RE = /^image\/(bmp|x-ms-bmp|tiff|heic|heif)\b/i;

/**
 * An attachment is an image when its name, its declared type or its first bytes
 * say so. The name alone is not enough: an image pasted into a message often
 * arrives with no extension (or no name), and must still meet the image rules.
 */
export function isImageAttachment(attachment: {
  filename?: string;
  contentType?: string;
  content?: Buffer | Uint8Array | string;
}): boolean {
  const name = attachment.filename || "";
  if (isImageFilename(name) || isUnrenderableImage(attachment)) return true;
  if ((attachment.contentType || "").toLowerCase().startsWith("image/")) {
    return true;
  }
  return (
    Buffer.isBuffer(attachment.content) &&
    readImageFacts(attachment.content) !== null
  );
}

/** A BMP, TIFF or HEIC: an image, but one the pipeline cannot render. */
export function isUnrenderableImage(attachment: {
  filename?: string;
  contentType?: string;
}): boolean {
  const name = attachment.filename || "";
  const dot = name.lastIndexOf(".");
  return (
    (dot >= 0 &&
      UNRENDERABLE_IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())) ||
    UNRENDERABLE_IMAGE_TYPE_RE.test(attachment.contentType || "")
  );
}

export interface ImageFacts {
  width: number;
  height: number;
  bytes: number;
}

export type ImageClassKind = "signature" | "content" | "ambiguous";

export interface ImageClass {
  kind: ImageClassKind;
  /** The signal that decided, written to the audit trail. */
  signal: string;
}

export function isImageFilename(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/** Reads width and height from the file header; null when it is not a readable image. */
export function readImageFacts(buffer: Buffer): ImageFacts | null {
  const bytes = buffer.length;
  // PNG: 8-byte signature, then the IHDR chunk with width and height.
  if (
    bytes >= 24 &&
    buffer.readUInt32BE(0) === 0x89504e47 &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      bytes,
    };
  }
  // GIF: "GIF87a" / "GIF89a", then little-endian width and height.
  if (bytes >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
      bytes,
    };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (
        marker === 0xd8 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01
      ) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          bytes,
        };
      }
      offset += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container; lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (
    bytes >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const kind = buffer.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
        bytes,
      };
    }
    if (kind === "VP8 ") {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
        bytes,
      };
    }
    if (kind === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        bytes,
      };
    }
  }
  return null;
}

const SIGNATURE_NAME_RE =
  /^(image\d{1,4}|outlook-[\w.-]*|~?wrd\d+|logo[\w.-]*|[\w.-]*logo|banner[\w.-]*|signature[\w.-]*|linkedin|facebook|twitter|instagram|youtube|spacer|pixel|icon[\w.-]*)(\.\w+)?$/i;

/** A picture up to this size on its longest side, with a signature-like name, is a signature. */
const NAMED_SIGNATURE_MAX_SIDE = 400;
const NAMED_SIGNATURE_MAX_BYTES = 60_000;
const ICON_MAX_SIDE = 64;
const TINY_FILE_BYTES = 5_000;
const BANNER_RATIO = 5;
const BANNER_MAX_HEIGHT = 160;
/** About 700 x 700 pixels, or a photo-sized file: document-sized. */
const CONTENT_MIN_PIXELS = 490_000;
const CONTENT_MIN_BYTES = 100_000;

export function classifyImage(
  filename: string,
  facts: ImageFacts,
  options: { inline?: boolean } = {},
): ImageClass {
  const { width, height, bytes } = facts;
  const longest = Math.max(width, height);

  // Layer 2: shape.
  if (width <= 2 || height <= 2) {
    return { kind: "signature", signal: "tracking pixel" };
  }
  if (longest <= ICON_MAX_SIDE) {
    return { kind: "signature", signal: `small icon (${width}x${height})` };
  }
  if (bytes < TINY_FILE_BYTES) {
    return { kind: "signature", signal: `tiny file (${bytes} bytes)` };
  }
  if (width / height >= BANNER_RATIO && height <= BANNER_MAX_HEIGHT) {
    return { kind: "signature", signal: `banner (${width}x${height})` };
  }

  // Layer 3: name, together with a small picture.
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const named = SIGNATURE_NAME_RE.test(base);
  if (
    named &&
    longest <= NAMED_SIGNATURE_MAX_SIDE &&
    bytes <= NAMED_SIGNATURE_MAX_BYTES
  ) {
    return { kind: "signature", signal: `signature-style name "${base}"` };
  }

  // An attached picture of document size is most likely content.
  if (
    !options.inline &&
    !named &&
    (width * height >= CONTENT_MIN_PIXELS || bytes >= CONTENT_MIN_BYTES)
  ) {
    return {
      kind: "content",
      signal: `document-sized attachment (${width}x${height})`,
    };
  }
  return {
    kind: "ambiguous",
    signal: `could be content (${width}x${height}, ${bytes} bytes)`,
  };
}
