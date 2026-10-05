import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { finalizeStandaloneDeliverables } from "../../../src/lib/standalone-processor";

const HASHES = [
  "0123456789abcdef",
  "1111111111111111",
  "fedcba9876543210",
] as const;

function withDirs(run: (documents: string, messages: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "files-final-"));
  const documents = path.join(root, "Documents");
  const messages = path.join(root, "Messages");
  fs.mkdirSync(documents);
  fs.mkdirSync(messages);
  try {
    run(documents, messages);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(dir: string, name: string, content = name) {
  fs.writeFileSync(path.join(dir, name), content);
}

function listing(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((name) => fs.statSync(path.join(dir, name)).isFile())
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]),
  );
}

describe("finalizeStandaloneDeliverables", () => {
  it("numbers a first run's hash-named files 1..N in natural order", () => {
    withDirs((documents, messages) => {
      write(documents, `Document ${HASHES[2]}.pdf`, "c");
      write(documents, `Document ${HASHES[0]}.pdf`, "a");
      write(documents, `Document ${HASHES[1]}.docx`, "b");
      write(messages, `Message ${HASHES[0]}.pdf`, "m");
      const result = finalizeStandaloneDeliverables({
        documentsDir: documents,
        messagesDir: messages,
      });
      assert.deepEqual(result, { documents: 3, messages: 1 });
      assert.deepEqual(listing(documents), {
        "Document 1.pdf": "a",
        "Document 2.docx": "b",
        "Document 3.pdf": "c",
      });
      assert.deepEqual(listing(messages), { "Message 1.pdf": "m" });
    });
  });

  it("keeps earlier waves' files and continues numbering after them", () => {
    withDirs((documents, messages) => {
      for (const n of [1, 2, 3])
        write(documents, `Document ${n}.pdf`, `old${n}`);
      fs.mkdirSync(path.join(documents, "Unconverted"));
      write(path.join(documents, "Unconverted"), "abc-x.bin", "u");
      write(documents, `Document ${HASHES[1]}.pdf`, "new-b");
      write(documents, `Document ${HASHES[0]}.pdf`, "new-a");
      const before = fs.statSync(path.join(documents, "Document 1.pdf")).ino;
      const result = finalizeStandaloneDeliverables({
        documentsDir: documents,
        messagesDir: messages,
      });
      assert.deepEqual(result, { documents: 2, messages: 0 });
      assert.deepEqual(listing(documents), {
        "Document 1.pdf": "old1",
        "Document 2.pdf": "old2",
        "Document 3.pdf": "old3",
        "Document 4.pdf": "new-a",
        "Document 5.pdf": "new-b",
      });
      assert.equal(
        fs.statSync(path.join(documents, "Document 1.pdf")).ino,
        before,
      );
      assert.ok(
        fs.existsSync(path.join(documents, "Unconverted", "abc-x.bin")),
      );
    });
  });

  it("keeps the existing width and old names when numbers grow", () => {
    withDirs((documents, messages) => {
      write(documents, "Document 0099.pdf", "old");
      write(documents, `Document ${HASHES[0]}.pdf`, "a");
      write(documents, `Document ${HASHES[1]}.pdf`, "b");
      finalizeStandaloneDeliverables({
        documentsDir: documents,
        messagesDir: messages,
      });
      assert.deepEqual(listing(documents), {
        "Document 0099.pdf": "old",
        "Document 0100.pdf": "a",
        "Document 0101.pdf": "b",
      });
    });
  });
});
