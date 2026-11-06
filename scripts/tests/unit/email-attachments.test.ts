import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Attachment } from "mailparser";
import * as xlsx from "xlsx";
import { renderEmailAttachments } from "../../../src/lib/converter";

let work: string;
before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "att-"));
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

/** A one-page PDF whose text layer is `text`. */
function pdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 12 Tf 10 50 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 10 50 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const BUILD_ZIP = `
import json, struct, sys, zipfile
spec = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for name, source in spec["files"].items():
        z.writestr(name, open(source, "rb").read())
if spec.get("encrypted"):
    data = bytearray(open(sys.argv[1], "rb").read())
    cd = data.rfind(b"PK\\x01\\x02")
    struct.pack_into("<H", data, cd + 8, struct.unpack_from("<H", data, cd + 8)[0] | 1)
    open(sys.argv[1], "wb").write(data)
`;

let counter = 0;
function file(name: string, data: Buffer | string): string {
  const target = path.join(work, `${counter++}-${name}`);
  fs.writeFileSync(target, data);
  return target;
}

function zip(files: Record<string, Buffer>, encrypted = false): Buffer {
  const sources = Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, file("src", data)]),
  );
  const target = path.join(work, `${counter++}.zip`);
  assert.equal(
    spawnSync("python3", [
      "-c",
      BUILD_ZIP,
      target,
      JSON.stringify({ files: sources, encrypted }),
    ]).status,
    0,
  );
  return fs.readFileSync(target);
}

function encryptedDocx(): Buffer {
  const container = xlsx.CFB.utils.cfb_new();
  xlsx.CFB.utils.cfb_add(container, "EncryptionInfo", Buffer.alloc(8192));
  xlsx.CFB.utils.cfb_add(container, "EncryptedPackage", Buffer.alloc(8192));
  return Buffer.from(xlsx.CFB.write(container, { type: "buffer" }) as Buffer);
}

const attachment = (filename: string, content: Buffer) =>
  ({ filename, content }) as unknown as Attachment;

async function render(
  attachments: Attachment[],
  options: { bypassKeywordFilter?: boolean } = {},
): Promise<string[]> {
  const outputDir = fs.mkdtempSync(path.join(work, "out-"));
  await renderEmailAttachments({
    attachments,
    currentBaseName: "Email 0001",
    outputDir,
    criteria: ["jonathan wheeler"],
    ...options,
  });
  return fs.readdirSync(outputDir).sort();
}

const relevant = () => pdf("Memo to Jonathan Wheeler about the project");
const unrelated = () => pdf("Quarterly catering invoice");

describe("email attachments", () => {
  it("delivers a convertible attachment that mentions the subject", async () => {
    assert.deepEqual(await render([attachment("memo.pdf", relevant())]), [
      "Email 0001 Attachment 1.pdf",
    ]);
  });

  it("expands a zip, delivers only converted entries, never the zip or raw files", async () => {
    const archive = zip({
      "a/memo.pdf": relevant(),
      "notes.txt": Buffer.from("raw notes"),
      "payload.exe": Buffer.from("MZ"),
    });
    assert.deepEqual(await render([attachment("bundle.zip", archive)]), [
      "Email 0001 Attachment 1.pdf",
    ]);
  });

  it("filters zip entries like any other attachment", async () => {
    const archive = zip({ "invoice.pdf": unrelated() });
    assert.deepEqual(await render([attachment("bundle.zip", archive)]), []);
  });

  it("drops a password-protected zip and does not leave it behind", async () => {
    const archive = zip({ "memo.pdf": relevant() }, true);
    assert.deepEqual(await render([attachment("secret.zip", archive)]), []);
    assert.deepEqual(
      await render([attachment("secret.zip", archive)], {
        bypassKeywordFilter: true,
      }),
      [],
      "a client case must not deliver it either",
    );
  });

  it("drops a password-protected Office attachment in every case type", async () => {
    for (const bypassKeywordFilter of [false, true]) {
      assert.deepEqual(
        await render([attachment("payroll.docx", encryptedDocx())], {
          bypassKeywordFilter,
        }),
        [],
      );
    }
  });

  it("expands nested zips but drops a protected zip inside one", async () => {
    const inner = zip({ "memo.pdf": relevant() });
    const locked = zip({ "memo.pdf": relevant() }, true);
    const outer = zip({ "inner.zip": inner, "locked.zip": locked });
    assert.deepEqual(await render([attachment("outer.zip", outer)]), [
      "Email 0001 Attachment 1.pdf",
    ]);
  });

  it("drops a protected entry inside an otherwise plain zip", async () => {
    const archive = zip({
      "payroll.docx": encryptedDocx(),
      "memo.pdf": relevant(),
    });
    assert.deepEqual(await render([attachment("bundle.zip", archive)]), [
      "Email 0001 Attachment 1.pdf",
    ]);
  });

  it("ignores attachments with no content and unsupported types", async () => {
    assert.deepEqual(
      await render([
        { filename: "empty.pdf" } as unknown as Attachment,
        attachment("image.png", Buffer.from("png")),
      ]),
      [],
    );
  });
});
