import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expandArchives } from "../../../src/lib/archive-expander";

// Reproduces the real failure: on the host share `unzip` cannot create files
// whose names are not valid UTF-8 and exits 50, which was treated as a full
// disk and retried until the job dead-lettered. A fake `unzip` that always
// exits 50 stands in for it.
function withFakeUnzip<T>(run: () => Promise<T>): Promise<T> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakebin-"));
  fs.writeFileSync(path.join(bin, "unzip"), "#!/bin/sh\nexit 50\n", {
    mode: 0o755,
  });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  return run().finally(() => {
    process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  });
}

const BUILD = `
import sys, zipfile
zipfile.ZipInfo._encodeFilenameFlags = lambda self: (self.filename.encode("utf-8"), self.flag_bits)
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr(zipfile.ZipInfo("Carta para o Comitê.pdf"), "letter")
    z.writestr(zipfile.ZipInfo("notes.txt"), "notes")
`;

function setup() {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "files-"));
  const zip = path.join(input, "Attachment 01.zip");
  assert.equal(spawnSync("python3", ["-c", BUILD, zip]).status, 0);
  return { input, zip };
}

const walk = (dir: string, found: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
};

describe("expandArchives when unzip fails with exit 50", () => {
  it("falls back to a name-aware extractor instead of failing the job", async () => {
    const { input, zip } = setup();
    const result = await withFakeUnzip(() => expandArchives(input));
    assert.equal(result.expanded, 1);
    assert.deepEqual(result.corrupted, []);
    assert.equal(
      fs.existsSync(zip),
      false,
      "the original zip is removed after extraction",
    );
    const names = walk(input)
      .map((f) => path.basename(f).normalize("NFC"))
      .sort();
    assert.deepEqual(
      names,
      ["Carta para o Comitê.pdf".normalize("NFC"), "notes.txt"].sort(),
    );
  });
});
