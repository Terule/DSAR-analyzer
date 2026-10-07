import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const SCRIPT = path.resolve(process.cwd(), "scripts/tools/extract_zip.py");

// Builds a zip whose entry names are written WITHOUT the "UTF-8" flag, exactly
// as many Windows and export tools do, so decoders have to guess.
const BUILD = `
import sys, zipfile
out, mode = sys.argv[1], sys.argv[2]
enc = {"utf8": "utf-8", "cp437": "cp437"}[mode]
zipfile.ZipInfo._encodeFilenameFlags = lambda self: (self.filename.encode(enc), self.flag_bits)
with zipfile.ZipFile(out, "w") as z:
    for name in sys.argv[3:]:
        z.writestr(zipfile.ZipInfo(name), "content of " + name)
`;

function makeZip(mode: string, names: string[]): { zip: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xz-"));
  const zip = path.join(dir, "a.zip");
  const built = spawnSync("python3", ["-c", BUILD, zip, mode, ...names]);
  assert.equal(built.status, 0, built.stderr?.toString());
  stripUtf8Flag(zip);
  return { zip, dir };
}

// Newer Pythons set the zip "UTF-8" flag on every entry they write. Clear it in
// the file's bytes so the archive really is unflagged, like the exports that
// triggered the bug, whichever Python runs the test.
function stripUtf8Flag(zipPath: string) {
  const bytes = fs.readFileSync(zipPath);
  const clear = (signature: Buffer, offset: number) => {
    let at = bytes.indexOf(signature);
    while (at >= 0) {
      bytes[at + offset + 1] &= ~0x08; // bit 11 of the 16-bit flags
      at = bytes.indexOf(signature, at + 4);
    }
  };
  clear(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 6); // local file header
  clear(Buffer.from([0x50, 0x4b, 0x01, 0x02]), 8); // central directory entry
  fs.writeFileSync(zipPath, bytes);
}

function extract(zip: string, target: string) {
  return spawnSync("python3", [SCRIPT, zip, target], { encoding: "utf8" });
}

function listFiles(dir: string, base = dir, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, found);
    else found.push(path.relative(base, full).normalize("NFC"));
  }
  return found.sort();
}

describe("extract_zip.py", () => {
  it("restores accented names stored as unflagged UTF-8 (what failed on APFS)", () => {
    const { zip, dir } = makeZip("utf8", [
      "Data Room/Carta para o Comitê [EN-PT].pdf",
      "Data Room/Resumo da sentença.pdf",
    ]);
    const target = path.join(dir, "out");
    const result = extract(zip, target);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listFiles(target), [
      "Data Room/Carta para o Comitê [EN-PT].pdf".normalize("NFC"),
      "Data Room/Resumo da sentença.pdf".normalize("NFC"),
    ]);
    assert.equal(
      fs.readFileSync(
        path.join(target, "Data Room", "Resumo da sentença.pdf"),
        "utf8",
      ),
      "content of Data Room/Resumo da sentença.pdf",
    );
  });

  it("still extracts when the names are in an old DOS code page", () => {
    const { zip, dir } = makeZip("cp437", ["café.txt"]);
    const target = path.join(dir, "out");
    const result = extract(zip, target);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listFiles(target), ["café.txt".normalize("NFC")]);
  });

  it("extracts plain ASCII archives and nested folders", () => {
    const { zip, dir } = makeZip("utf8", ["a/b/c.txt", "top.txt"]);
    const target = path.join(dir, "out");
    assert.equal(extract(zip, target).status, 0);
    assert.deepEqual(listFiles(target), ["a/b/c.txt", "top.txt"]);
  });

  it("skips entries that try to escape the target folder (exit 1)", () => {
    const { zip, dir } = makeZip("utf8", [
      "ok.txt",
      "../evil.txt",
      "/abs/evil2.txt",
    ]);
    const target = path.join(dir, "out");
    const result = extract(zip, target);
    assert.equal(result.status, 1);
    assert.deepEqual(listFiles(target), ["ok.txt"]);
    assert.equal(fs.existsSync(path.join(dir, "evil.txt")), false);
    assert.equal(fs.existsSync("/abs/evil2.txt"), false);
  });

  it("shortens a name that is too long for the file system", () => {
    const long = `${"x".repeat(300)}.txt`;
    const { zip, dir } = makeZip("utf8", [long]);
    const target = path.join(dir, "out");
    assert.equal(extract(zip, target).status, 0);
    const files = listFiles(target);
    assert.equal(files.length, 1);
    assert.ok(Buffer.byteLength(files[0]) <= 255);
    assert.ok(files[0].endsWith(".txt"));
  });

  it("reports a corrupt archive as exit 2", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xz-"));
    const zip = path.join(dir, "bad.zip");
    fs.writeFileSync(zip, "this is not a zip file");
    assert.equal(extract(zip, path.join(dir, "out")).status, 2);
  });

  it("reports names that cannot be decoded at all as exit 3, not as corrupt", () => {
    // A flagged-UTF-8 name whose bytes are not valid UTF-8.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xz-"));
    const zip = path.join(dir, "a.zip");
    const build = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr(zipfile.ZipInfo("café.txt"), "x")
`;
    assert.equal(spawnSync("python3", ["-c", build, zip]).status, 0);
    const bytes = fs.readFileSync(zip);
    const from = Buffer.from("café.txt", "utf8");
    let at = bytes.indexOf(from);
    assert.ok(at >= 0);
    while (at >= 0) {
      Buffer.from([0x63, 0x61, 0x66, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]).copy(
        bytes,
        at,
      );
      at = bytes.indexOf(from, at + from.length);
    }
    fs.writeFileSync(zip, bytes);
    assert.equal(extract(zip, path.join(dir, "out")).status, 3);
  });
});
