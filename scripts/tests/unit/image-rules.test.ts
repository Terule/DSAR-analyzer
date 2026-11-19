import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import type { Attachment } from "mailparser";
import { renderEmailAttachments } from "../../../src/lib/converter";
import {
  classifyImage,
  isImageFilename,
  readImageFacts,
} from "../../../src/lib/image-rules";
import {
  type FileDecision,
  runStandaloneBatch,
} from "../../../src/lib/standalone-processor";

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
  return out;
}

/** A real PNG; `noisy` makes it incompressible so the file has a photo-like size. */
function png(width: number, height: number, noisy = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  if (noisy) {
    for (let y = 0; y < height; y++) {
      crypto.randomFillSync(raw, y * row + 1, width * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("image header reading", () => {
  it("reads PNG, GIF and JPEG dimensions", () => {
    assert.deepEqual(readImageFacts(png(40, 30)), {
      width: 40,
      height: 30,
      bytes: png(40, 30).length,
    });
    const gif = Buffer.alloc(16);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(120, 6);
    gif.writeUInt16LE(60, 8);
    assert.equal(readImageFacts(gif)?.width, 120);
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    const facts = readImageFacts(jpeg);
    assert.equal(facts?.width, 800);
    assert.equal(facts?.height, 600);
  });

  it("returns null for anything else", () => {
    assert.equal(
      readImageFacts(Buffer.from("not an image at all, really")),
      null,
    );
    assert.equal(isImageFilename("scan.JPG"), true);
    assert.equal(isImageFilename("deck.pptx"), false);
  });
});

describe("signature or content", () => {
  const facts = (width: number, height: number, bytes: number) => ({
    width,
    height,
    bytes,
  });
  it("shape: tracking pixel, icon, tiny file and banner are signatures", () => {
    for (const [f, signal] of [
      [facts(1, 1, 90), "tracking pixel"],
      [facts(48, 48, 9_000), "small icon"],
      [facts(500, 300, 3_000), "tiny file"],
      [facts(700, 90, 40_000), "banner"],
    ] as const) {
      const verdict = classifyImage("x.png", f);
      assert.equal(verdict.kind, "signature");
      assert.match(verdict.signal, new RegExp(signal));
    }
  });

  it("name counts only together with a small picture", () => {
    assert.equal(
      classifyImage("image001.png", facts(300, 120, 20_000)).kind,
      "signature",
    );
    assert.equal(
      classifyImage("Outlook-abc123.png", facts(250, 250, 30_000)).kind,
      "signature",
    );
    // A pasted screenshot is also called image001.png.
    assert.notEqual(
      classifyImage("image001.png", facts(1280, 900, 400_000)).kind,
      "signature",
    );
  });

  it("a document-sized attachment is content, a middling one is ambiguous", () => {
    assert.equal(
      classifyImage("scan.jpg", facts(1600, 1200, 800_000)).kind,
      "content",
    );
    assert.equal(
      classifyImage("photo.jpg", facts(420, 300, 40_000)).kind,
      "ambiguous",
    );
  });
});

describe("images attached to emails", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "image-rules-"));
  const attachment = (filename: string, content: Buffer, related?: boolean) =>
    ({ filename, content, related }) as unknown as Attachment;

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

  it("drops a signature image with the signal, delivers nothing", async () => {
    const result = await render([attachment("logo.png", png(120, 40))]);
    assert.deepEqual(result.delivered, []);
    assert.deepEqual(result.review, []);
    assert.equal(result.drops[0].rule, "signature_image");
    assert.match(result.drops[0].reason, /Signature or decoration image/);
  });

  it("sends a document-sized image to review as a PDF, never to delivery", async () => {
    const result = await render([attachment("scan.png", png(300, 300, true))]);
    assert.deepEqual(result.delivered, []);
    assert.deepEqual(result.review, ["Email 0001 Image 1.pdf"]);
    assert.deepEqual(result.drops, []);
  });

  it("ignores an image embedded in the message body", async () => {
    const result = await render([
      attachment("scan.png", png(300, 300, true), true),
    ]);
    assert.deepEqual(result, { delivered: [], review: [], drops: [] });
  });

  it("reports an unreadable image", async () => {
    const result = await render([
      attachment("broken.png", Buffer.from("not really a png")),
    ]);
    assert.equal(result.drops[0].rule, "unreadable_image");
  });
});

describe("images in a Files folder", () => {
  it("drops a signature image with its rule and renders any other image as a PDF", async () => {
    const input = fs.mkdtempSync(path.join(os.tmpdir(), "img-files-in-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "img-files-out-"));
    const logo = path.join(input, "logo.png");
    const scan = path.join(input, "scan.png");
    fs.writeFileSync(logo, png(120, 40));
    fs.writeFileSync(scan, png(300, 300, true));
    const decisions: FileDecision[] = [];
    const original = console.log;
    console.log = () => {};
    try {
      await runStandaloneBatch({
        inputDir: input,
        filePaths: [logo, scan],
        messagesDir: path.join(out, "Messages"),
        documentsDir: path.join(out, "Documents"),
        subjectCriteria: { name: "Maria Souza", email: "maria.souza@corp.com" },
        onDecision: (d) => {
          if (d.state === "discarded") decisions.push(d);
        },
      });
    } finally {
      console.log = original;
    }
    assert.deepEqual(
      decisions.map((d) => [path.basename(d.filePath), d.rule]),
      [["logo.png", "signature_image"]],
    );
    const documents = fs.readdirSync(path.join(out, "Documents"));
    assert.equal(documents.length, 1);
    assert.match(documents[0], /\.pdf$/);
  });
});
