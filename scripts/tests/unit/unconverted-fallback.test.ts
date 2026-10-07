import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { copyUnconvertedStandaloneFiles } from "../../../src/lib/standalone-processor";

function workbook(dir: string, name: string, strings: string[]): string {
  const target = path.join(dir, name);
  const build = `
import sys, json, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("xl/sharedStrings.xml", "<sst>" + "".join("<si><t>%s</t></si>" % s for s in json.loads(sys.argv[2])) + "</sst>")
`;
  assert.equal(
    spawnSync("python3", ["-c", build, target, JSON.stringify(strings)]).status,
    0,
  );
  return target;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-out-"));
  return {
    dir,
    messagesDir: path.join(out, "Messages"),
    documentsDir: path.join(out, "Documents"),
  };
}

const delivered = (documentsDir: string) => {
  const folder = path.join(documentsDir, "Unconverted");
  return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
};

describe("copyUnconvertedStandaloneFiles with the pre-screen", () => {
  let previous: string | undefined;
  before(() => {
    previous = process.env.XLSX_PRESCREEN_MB;
    process.env.XLSX_PRESCREEN_MB = "0.000001"; // every workbook counts as large
  });
  after(() => {
    if (previous === undefined) delete process.env.XLSX_PRESCREEN_MB;
    else process.env.XLSX_PRESCREEN_MB = previous;
  });

  it("does not deliver a large workbook that cannot mention the subject", async () => {
    const t = setup();
    const unrelated = workbook(t.dir, "Claimants.xlsx", [
      "Name",
      "Jonathan Silva",
    ]);
    const result = await copyUnconvertedStandaloneFiles({
      filePaths: [unrelated],
      messagesDir: t.messagesDir,
      documentsDir: t.documentsDir,
      criteria: ["jonathan wheeler"],
    });
    assert.deepEqual(result, { copied: 0, missing: 0, dropped: 1 });
    assert.deepEqual(delivered(t.documentsDir), []);
  });

  it("still delivers one that mentions the subject, and anything it cannot judge", async () => {
    const t = setup();
    const mentions = workbook(t.dir, "Users.xlsx", ["Jonathan Wheeler"]);
    const legacy = path.join(t.dir, "Old.xls");
    fs.writeFileSync(legacy, "binary xls, not a zip");
    const memo = path.join(t.dir, "Memo.docx");
    fs.writeFileSync(memo, "docx bytes");
    const result = await copyUnconvertedStandaloneFiles({
      filePaths: [mentions, legacy, memo],
      messagesDir: t.messagesDir,
      documentsDir: t.documentsDir,
      criteria: ["jonathan wheeler"],
    });
    assert.deepEqual(result, { copied: 3, missing: 0, dropped: 0 });
    assert.equal(delivered(t.documentsDir).length, 3);
  });

  it("keeps everything when no criteria are given (client cases)", async () => {
    const t = setup();
    const unrelated = workbook(t.dir, "Claimants.xlsx", ["Jonathan Silva"]);
    const result = await copyUnconvertedStandaloneFiles({
      filePaths: [unrelated],
      messagesDir: t.messagesDir,
      documentsDir: t.documentsDir,
    });
    assert.deepEqual(result, { copied: 1, missing: 0, dropped: 0 });
  });

  it("still counts files that no longer exist", async () => {
    const t = setup();
    const result = await copyUnconvertedStandaloneFiles({
      filePaths: [path.join(t.dir, "gone.xlsx")],
      messagesDir: t.messagesDir,
      documentsDir: t.documentsDir,
      criteria: ["jonathan wheeler"],
    });
    assert.deepEqual(result, { copied: 0, missing: 1, dropped: 0 });
  });
});
