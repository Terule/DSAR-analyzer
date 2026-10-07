import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyDiscards,
  writeVerdictsCsv,
} from "../../../src/lib/files-ai-apply";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fai-apply-"));
}

function setup() {
  const root = tmp();
  fs.mkdirSync(path.join(root, "Documents"));
  fs.mkdirSync(path.join(root, "Messages"));
  fs.writeFileSync(path.join(root, "Documents", "Document a.pdf"), "doc");
  fs.writeFileSync(path.join(root, "Messages", "Message b.pdf"), "msg");
  return root;
}

describe("applyDiscards", () => {
  it("moves a discard into Discarded/ keeping its folder", () => {
    const root = setup();
    const result = applyDiscards({
      requestOutputDir: root,
      discards: [{ relPath: "Documents/Document a.pdf", reason: "r" }],
    });
    assert.deepEqual(result, { moved: 1, alreadyMoved: 0 });
    assert.equal(
      fs.existsSync(path.join(root, "Documents", "Document a.pdf")),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(root, "Discarded", "Documents", "Document a.pdf"),
        "utf8",
      ),
      "doc",
    );
    assert.equal(
      fs.existsSync(path.join(root, "Messages", "Message b.pdf")),
      true,
    );
  });

  it("is idempotent: a second run reports it as already moved", () => {
    const root = setup();
    const input = {
      requestOutputDir: root,
      discards: [{ relPath: "Messages/Message b.pdf", reason: "r" }],
    };
    applyDiscards(input);
    assert.deepEqual(applyDiscards(input), { moved: 0, alreadyMoved: 1 });
  });

  it("ignores a file that is gone and was never moved", () => {
    const root = setup();
    assert.deepEqual(
      applyDiscards({
        requestOutputDir: root,
        discards: [{ relPath: "Documents/Document zzz.pdf", reason: "r" }],
      }),
      { moved: 0, alreadyMoved: 0 },
    );
  });

  for (const bad of [
    "../escape.pdf",
    "/abs/x.pdf",
    "Emails/x.pdf",
    "Documents/../../x.pdf",
    "Documents/sub/x.pdf",
  ]) {
    it(`rejects the unsafe path ${bad}`, () => {
      assert.throws(
        () =>
          applyDiscards({
            requestOutputDir: setup(),
            discards: [{ relPath: bad, reason: "r" }],
          }),
        /Unsafe/,
      );
    });
  }
});

describe("writeVerdictsCsv", () => {
  it("quotes commas, quotes and newlines", () => {
    const root = tmp();
    const file = writeVerdictsCsv({
      requestOutputDir: root,
      rows: [
        {
          relPath: "Documents/Document a.pdf",
          verdict: "discard",
          reason: 'Has "quotes", commas\nand a newline',
        },
      ],
    });
    assert.equal(file, path.join(root, "Discarded", "verdicts.csv"));
    assert.equal(
      fs.readFileSync(file, "utf8"),
      'file,verdict,reason\n"Documents/Document a.pdf","discard","Has ""quotes"", commas\nand a newline"\n',
    );
  });

  it("rewrites the file instead of appending", () => {
    const root = tmp();
    const row = {
      relPath: "Messages/Message b.pdf",
      verdict: "discard",
      reason: "x",
    };
    writeVerdictsCsv({ requestOutputDir: root, rows: [row, row] });
    const file = writeVerdictsCsv({ requestOutputDir: root, rows: [row] });
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2);
  });
});
