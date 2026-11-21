/**
 * Turns the image formats the pipeline cannot read (BMP, TIFF, HEIC/HEIF) into
 * a PNG, so they go through the same rules, vision check and PDF rendering as
 * any other picture. sharp and the browser cannot do it: neither reads all
 * three, and sharp leaves HEVC out for patent reasons.
 *
 *  - BMP and TIFF: Pillow (python3-pil, already installed for WeasyPrint);
 *  - HEIC/HEIF: `heif-convert` (Debian package libheif-examples).
 *
 * A conversion that fails or times out returns null: the caller keeps the
 * original for a person, it never drops the image for that.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 60_000;
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

const PILLOW_EXTENSIONS = new Set([".bmp", ".tif", ".tiff"]);
const HEIF_EXTENSIONS = new Set([".heic", ".heif"]);

// Pillow refuses a decompression bomb by default; that is what we want, so a
// refusal is a failed conversion and the original goes to a person.
const PILLOW_SCRIPT = `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
im.seek(0)
if im.mode not in ("RGB", "RGBA", "L"):
    im = im.convert("RGBA" if "A" in im.mode or "transparency" in im.info else "RGB")
im.save(sys.argv[2], "PNG")
`;

function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: TIMEOUT_MS, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

/** The extension a conversion handles for this name or declared type, or null. */
export function convertibleImageExtension(
  filename: string,
  contentType = "",
): string | null {
  const ext = path.extname(filename || "").toLowerCase();
  if (PILLOW_EXTENSIONS.has(ext) || HEIF_EXTENSIONS.has(ext)) return ext;
  const type = contentType.toLowerCase();
  if (/^image\/(bmp|x-ms-bmp)\b/.test(type)) return ".bmp";
  if (/^image\/tiff\b/.test(type)) return ".tiff";
  if (/^image\/hei[cf]\b/.test(type)) return ".heic";
  return null;
}

/** The PNG of a BMP, TIFF or HEIC; null when it cannot be converted. */
export async function convertImageToPng(
  content: Buffer,
  extension: string,
): Promise<Buffer | null> {
  if (content.length === 0 || content.length > MAX_INPUT_BYTES) return null;
  const ext = extension.toLowerCase();
  const heif = HEIF_EXTENSIONS.has(ext);
  if (!heif && !PILLOW_EXTENSIONS.has(ext)) return null;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aida-img-"));
  try {
    const input = path.join(directory, `in${ext}`);
    const output = path.join(directory, "out.png");
    fs.writeFileSync(input, content);
    const ok = heif
      ? await run("heif-convert", [input, output])
      : await run("python3", ["-I", "-c", PILLOW_SCRIPT, input, output]);
    // heif-convert names a multi-image file `out-1.png`, `out-2.png`: the
    // primary image is the one a person expects.
    const produced = [output, path.join(directory, "out-1.png")].find((file) =>
      fs.existsSync(file),
    );
    if (!ok || !produced) return null;
    if (fs.statSync(produced).size > MAX_OUTPUT_BYTES) return null;
    return fs.readFileSync(produced);
  } catch {
    return null;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
