import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as xlsx from "xlsx";
import { expandArchives } from "../../../src/lib/archive-expander";
import {
  isPasswordProtectedFile,
  isPasswordProtectionError,
} from "../../../src/lib/password-protection";
import { copyUnconvertedStandaloneFiles } from "../../../src/lib/standalone-processor";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwd-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, data: Buffer | string): string {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
}

// Streams >= 4096 bytes stay out of the mini stream, like real Word/Excel ones.
const padded = (head: Buffer) =>
  Buffer.concat([head, Buffer.alloc(8192 - head.length)]);

function ole(streams: Record<string, Buffer>): Buffer {
  const container = xlsx.CFB.utils.cfb_new();
  for (const [name, data] of Object.entries(streams)) {
    xlsx.CFB.utils.cfb_add(container, name, data);
  }
  return Buffer.from(xlsx.CFB.write(container, { type: "buffer" }) as Buffer);
}

describe("OLE / Office", () => {
  it("detects an encrypted OOXML wrapper (docx/xlsx/pptx) by its streams", () => {
    const file = write(
      "salaries.xlsx",
      ole({
        EncryptionInfo: padded(Buffer.from([4, 0, 4, 0])),
        EncryptedPackage: padded(Buffer.from("ciphertext")),
      }),
    );
    assert.equal(isPasswordProtectedFile(file), true);
  });

  it("detects a password-protected legacy .doc (FIB fEncrypted)", () => {
    const fib = Buffer.alloc(32);
    fib.writeUInt16LE(0xa5ec, 0);
    fib.writeUInt16LE(0x0100, 0x0a);
    const file = write("old.doc", ole({ WordDocument: padded(fib) }));
    assert.equal(isPasswordProtectedFile(file), true);
  });

  it("does not flag a legacy .doc without the flag", () => {
    const fib = Buffer.alloc(32);
    fib.writeUInt16LE(0xa5ec, 0);
    const file = write("plain.doc", ole({ WordDocument: padded(fib) }));
    assert.equal(isPasswordProtectedFile(file), false);
  });

  it("detects a password-protected legacy .xls (FILEPASS after BOF)", () => {
    const bof = Buffer.alloc(4 + 16);
    bof.writeUInt16LE(0x0809, 0);
    bof.writeUInt16LE(16, 2);
    const filepass = Buffer.from([0x2f, 0x00, 0x04, 0x00, 0, 0, 0, 0]);
    const file = write(
      "old.xls",
      ole({ Workbook: padded(Buffer.concat([bof, filepass])) }),
    );
    assert.equal(isPasswordProtectedFile(file), true);
  });

  it("does not flag a normal .xls", () => {
    const bof = Buffer.alloc(4 + 16);
    bof.writeUInt16LE(0x0809, 0);
    bof.writeUInt16LE(16, 2);
    const next = Buffer.from([0x42, 0x00, 0x02, 0x00, 0xe4, 0x04]);
    const file = write(
      "normal.xls",
      ole({ Workbook: padded(Buffer.concat([bof, next])) }),
    );
    assert.equal(isPasswordProtectedFile(file), false);
  });

  it("does not flag a normal OOXML workbook", () => {
    const book = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(
      book,
      xlsx.utils.aoa_to_sheet([["a", 1]]),
      "S",
    );
    const file = write(
      "ok.xlsx",
      xlsx.write(book, { type: "buffer", bookType: "xlsx" }),
    );
    assert.equal(isPasswordProtectedFile(file), false);
  });
});

const BUILD_ZIP = `
import struct, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("a.txt", "secret")
if sys.argv[2] == "enc":
    data = bytearray(open(sys.argv[1], "rb").read())
    # set the encryption bit in the central directory entry's flags
    cd = data.rfind(b"PK\\x01\\x02")
    flags = struct.unpack_from("<H", data, cd + 8)[0] | 1
    struct.pack_into("<H", data, cd + 8, flags)
    open(sys.argv[1], "wb").write(data)
`;

function zip(name: string, mode: "enc" | "plain"): string {
  const target = path.join(dir, name);
  assert.equal(spawnSync("python3", ["-c", BUILD_ZIP, target, mode]).status, 0);
  return target;
}

describe("ZIP", () => {
  it("detects an encrypted entry, by signature rather than extension", () => {
    assert.equal(isPasswordProtectedFile(zip("a.zip", "enc")), true);
    assert.equal(isPasswordProtectedFile(zip("b.docx", "enc")), true);
  });
  it("does not flag a plain zip", () => {
    assert.equal(isPasswordProtectedFile(zip("c.zip", "plain")), false);
  });
});

describe("RAR and 7z", () => {
  const rar4Block = (type: number, flags: number, body: Buffer) => {
    const head = Buffer.alloc(7);
    head.writeUInt8(type, 2);
    head.writeUInt16LE(flags, 3);
    head.writeUInt16LE(7 + body.length, 5);
    return Buffer.concat([head, body]);
  };
  const RAR4 = Buffer.from("526172211a0700", "hex");

  it("detects RAR4 encrypted headers and encrypted files", () => {
    const main = (flags: number) => rar4Block(0x73, flags, Buffer.alloc(6));
    assert.equal(
      isPasswordProtectedFile(
        write("h.rar", Buffer.concat([RAR4, main(0x0080)])),
      ),
      true,
    );
    const file = (flags: number) => rar4Block(0x74, flags, Buffer.alloc(25));
    assert.equal(
      isPasswordProtectedFile(
        write("f.rar", Buffer.concat([RAR4, main(0), file(0x0004)])),
      ),
      true,
    );
    assert.equal(
      isPasswordProtectedFile(
        write("p.rar", Buffer.concat([RAR4, main(0), file(0)])),
      ),
      false,
    );
  });

  it("detects the RAR5 archive-encryption header", () => {
    // CRC32, header size (vint 3), type 4, flags 0, one body byte
    const block = Buffer.from([0, 0, 0, 0, 3, 4, 0, 0]);
    const rar5 = Buffer.from("526172211a070100", "hex");
    assert.equal(
      isPasswordProtectedFile(write("e5.rar", Buffer.concat([rar5, block]))),
      true,
    );
    // type 1 = main archive header: not encrypted
    const main = Buffer.from([0, 0, 0, 0, 3, 1, 0, 0]);
    assert.equal(
      isPasswordProtectedFile(write("p5.rar", Buffer.concat([rar5, main]))),
      false,
    );
  });

  it("detects a 7z whose header lists the AES coder", () => {
    const aes = Buffer.from([0x17, 0x06, 0xf1, 0x07, 0x01, 0x00]);
    const start = Buffer.alloc(32);
    Buffer.from("377abcaf271c", "hex").copy(start);
    start.writeBigUInt64LE(BigInt(0), 12);
    start.writeBigUInt64LE(BigInt(aes.length), 20);
    assert.equal(
      isPasswordProtectedFile(write("e.7z", Buffer.concat([start, aes]))),
      true,
    );
    const plain = Buffer.from([0x01, 0x04, 0x00]);
    start.writeBigUInt64LE(BigInt(plain.length), 20);
    assert.equal(
      isPasswordProtectedFile(write("p.7z", Buffer.concat([start, plain]))),
      false,
    );
  });
});

describe("robustness", () => {
  it("never throws on missing, empty or random files", () => {
    assert.equal(isPasswordProtectedFile(path.join(dir, "nope")), false);
    assert.equal(isPasswordProtectedFile(write("empty", "")), false);
    assert.equal(
      isPasswordProtectedFile(write("junk.bin", "hello world")),
      false,
    );
  });
  it("classifies parser errors", () => {
    assert.equal(
      isPasswordProtectionError(new Error("No password given")),
      true,
    );
    assert.equal(isPasswordProtectionError(new Error("bad xref")), false);
    const named = new Error("x");
    named.name = "PasswordException";
    assert.equal(isPasswordProtectionError(named), true);
  });
});

describe("delivery paths", () => {
  it("expandArchives treats an encrypted zip as confidential in client mode too", async () => {
    for (const clientMode of [false, true]) {
      const input = fs.mkdtempSync(path.join(os.tmpdir(), "pwd-exp-"));
      try {
        fs.copyFileSync(
          zip(`client-${clientMode}.zip`, "enc"),
          path.join(input, "client.zip"),
        );
        const result = await expandArchives(input, { clientMode });
        assert.equal(result.confidential.length, 1, `clientMode=${clientMode}`);
        assert.deepEqual(result.keep, []);
        assert.equal(result.expanded, 0);
      } finally {
        fs.rmSync(input, { recursive: true, force: true });
      }
    }
  });

  it("the unconverted fallback never delivers a protected file", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "pwd-out-"));
    try {
      const locked = write(
        "fb.xlsx",
        ole({ EncryptedPackage: padded(Buffer.from("x")) }),
      );
      const result = await copyUnconvertedStandaloneFiles({
        filePaths: [locked],
        messagesDir: path.join(out, "Messages"),
        documentsDir: path.join(out, "Documents"),
      });
      assert.equal(result.copied, 0);
      assert.equal(result.dropped, 1);
      assert.equal(fs.existsSync(path.join(out, "Documents")), false);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
