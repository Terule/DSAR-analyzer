import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  countImageRecurrence,
  imageHash,
  isEmbeddedInBody,
} from "../../../src/lib/image-recurrence";

// A valid 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function eml(withImage: boolean, body: string): string {
  const boundary = "BOUNDARY";
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  if (withImage) {
    parts.push(
      `--${boundary}`,
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: attachment; filename="logo.png"',
      "Content-Transfer-Encoding: base64",
      "",
      PNG.toString("base64"),
    );
  }
  parts.push(`--${boundary}--`, "");
  return [
    "From: a@x.com",
    "To: b@x.com",
    "Subject: Hi",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
  ].join("\r\n");
}

test("counts the emails that carry the same image, once per email", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recur-"));
  const files: string[] = [];
  for (let i = 0; i < 5; i++) {
    const file = path.join(dir, `${i}.eml`);
    fs.writeFileSync(file, eml(true, `message ${i}`));
    files.push(file);
  }
  const plain = path.join(dir, "plain.eml");
  fs.writeFileSync(plain, eml(false, "no image here"));
  files.push(plain);

  const counts = await countImageRecurrence(files);
  assert.equal(counts.get(imageHash(PNG)), 5);
  assert.equal(counts.size, 1);
});

test("an image the body references by Content-ID is embedded", () => {
  assert.equal(
    isEmbeddedInBody({ contentId: "<a@b>" }, '<img src="cid:a@b">'),
    true,
  );
  assert.equal(isEmbeddedInBody({ contentId: "<a@b>" }, "<p>none</p>"), false);
  assert.equal(isEmbeddedInBody({ related: true }, undefined), true);
  assert.equal(isEmbeddedInBody({}, '<img src="cid:a@b">'), false);
});
