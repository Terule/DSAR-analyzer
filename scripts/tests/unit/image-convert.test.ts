import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Attachment } from "mailparser";
import { renderEmailAttachments } from "../../../src/lib/converter";
import {
  convertImageToPng,
  convertibleImageExtension,
} from "../../../src/lib/image-convert";
import { readImageFacts } from "../../../src/lib/image-rules";

/** A real 24-bit BMP; `noisy` makes it photo-sized and incompressible. */
function bmp(width: number, height: number, noisy = false): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const pixels = noisy
    ? crypto.randomBytes(row * height)
    : Buffer.alloc(row * height, 0x80);
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

describe("convertibleImageExtension", () => {
  it("knows BMP, TIFF and HEIC by name or declared type", () => {
    assert.equal(convertibleImageExtension("a.BMP"), ".bmp");
    assert.equal(convertibleImageExtension("a.tif"), ".tif");
    assert.equal(convertibleImageExtension("IMG_1.HEIC"), ".heic");
    assert.equal(convertibleImageExtension("x", "image/heif"), ".heic");
    assert.equal(convertibleImageExtension("x", "image/tiff"), ".tiff");
    assert.equal(convertibleImageExtension("a.png"), null);
  });
});

describe("convertImageToPng", () => {
  it("converts a BMP with Pillow", async () => {
    const png = await convertImageToPng(bmp(40, 30), ".bmp");
    assert.ok(png);
    const facts = readImageFacts(png);
    assert.equal(facts?.width, 40);
    assert.equal(facts?.height, 30);
  });

  it("returns null for bytes that are not the image they claim", async () => {
    assert.equal(await convertImageToPng(Buffer.from("nope"), ".bmp"), null);
    assert.equal(await convertImageToPng(Buffer.from("nope"), ".tiff"), null);
    assert.equal(await convertImageToPng(Buffer.from("nope"), ".heic"), null);
    assert.equal(await convertImageToPng(Buffer.alloc(0), ".bmp"), null);
    assert.equal(await convertImageToPng(Buffer.from("x"), ".gif"), null);
  });
});

describe("a BMP attached to an email", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "image-convert-"));
  const attach = (filename: string, content: Buffer) =>
    ({ filename, content }) as unknown as Attachment;

  async function render(attachments: Attachment[]) {
    const outputDir = fs.mkdtempSync(path.join(work, "out-"));
    const reviewDir = fs.mkdtempSync(path.join(work, "review-"));
    const drops: { filename: string; rule: string; reason: string }[] = [];
    await renderEmailAttachments({
      attachments,
      currentBaseName: "Email 0001",
      outputDir,
      reviewDir,
      criteria: ["jonathan wheeler"],
      onDrop: (d) => drops.push(d),
    });
    return {
      delivered: fs.readdirSync(outputDir).sort(),
      review: fs.readdirSync(reviewDir).sort(),
      drops,
    };
  }

  it("meets the image rules once converted: a document-sized one goes to review as a PDF", async () => {
    const result = await render([attach("scan.bmp", bmp(300, 300, true))]);
    assert.deepEqual(result.delivered, []);
    assert.deepEqual(result.review, ["Email 0001 Image 1.pdf"]);
    assert.deepEqual(result.drops, []);
  });

  it("is dropped as a signature once converted, when it is a small icon", async () => {
    const result = await render([attach("logo.bmp", bmp(24, 24))]);
    assert.deepEqual(result.review, []);
    assert.equal(result.drops[0].rule, "signature_image");
  });
});
