import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  listFilesAiCandidates,
  readPdfText,
} from "../../../src/lib/files-ai-extract";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "files-ai-"));
}

// A one-page PDF containing the given ASCII text; pdf.js rebuilds the xref.
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const HASH_A = "0123456789abcdef";
const HASH_B = "fedcba9876543210";

describe("listFilesAiCandidates", () => {
  it("lists only this wave's unfinalized PDFs", () => {
    const root = tmp();
    const docs = path.join(root, "Documents");
    const msgs = path.join(root, "Messages");
    fs.mkdirSync(path.join(docs, "Unconverted"), { recursive: true });
    fs.mkdirSync(msgs);
    fs.writeFileSync(path.join(docs, "Document 0001.pdf"), "x"); // earlier wave
    fs.writeFileSync(path.join(docs, `Document ${HASH_A}.pdf`), "x"); // this wave
    fs.writeFileSync(path.join(docs, `Document ${HASH_B}.docx`), "x"); // not a PDF
    fs.writeFileSync(path.join(docs, "Unconverted", "big.xlsx"), "x");
    fs.writeFileSync(path.join(docs, ".hidden"), "x");
    fs.writeFileSync(path.join(msgs, `Message ${HASH_B}.pdf`), "x");
    fs.writeFileSync(path.join(msgs, "Message 0001.pdf"), "x");
    const found = listFilesAiCandidates({
      documentsDir: docs,
      messagesDir: msgs,
    });
    assert.deepEqual(found.map((c) => c.relPath).sort(), [
      `Documents/Document ${HASH_A}.pdf`,
      `Messages/Message ${HASH_B}.pdf`,
    ]);
    assert.equal(
      found.find((c) => c.kind === "Message")?.fileName,
      `Message ${HASH_B}.pdf`,
    );
  });

  it("returns [] when the folders do not exist", () => {
    const root = tmp();
    assert.deepEqual(
      listFilesAiCandidates({
        documentsDir: path.join(root, "nope"),
        messagesDir: path.join(root, "nada"),
      }),
      [],
    );
  });
});

describe("readPdfText", () => {
  it("reads the text of a real PDF", async () => {
    const file = path.join(tmp(), "ok.pdf");
    fs.writeFileSync(file, tinyPdf("Hello Jonathan Wheeler"));
    assert.match(await readPdfText(file), /Hello Jonathan Wheeler/);
  });

  it("returns empty text for a corrupt or non-PDF file", async () => {
    const file = path.join(tmp(), "bad.pdf");
    fs.writeFileSync(file, "this is not a pdf");
    assert.equal(await readPdfText(file), "");
  });

  it("returns empty text for a missing file", async () => {
    assert.equal(await readPdfText("/definitely/not/here.pdf"), "");
  });
});
