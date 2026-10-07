import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  criteriaTokenSets,
  scanTextChunks,
  scanXlsxForMentions,
  shouldPrescreenSpreadsheet,
} from "../../../src/lib/xlsx-mention-scan";

const NAME = [["jonathan", "wheeler"]];

async function* chunked(text: string, size: number) {
  for (let i = 0; i < text.length; i += size) {
    yield Buffer.from(text.slice(i, i + size));
  }
}

describe("criteriaTokenSets", () => {
  it("splits each criterion into lower-case words and ignores blanks", () => {
    assert.deepEqual(
      criteriaTokenSets([
        "Jonathan  Wheeler",
        "JWheeler@pogustgoodhead.com",
        "  ",
      ]),
      [["jonathan", "wheeler"], ["jwheeler@pogustgoodhead.com"]],
    );
    assert.deepEqual(criteriaTokenSets([]), []);
  });
});

describe("scanTextChunks", () => {
  const strings = (...items: string[]) =>
    `<sst>${items.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`;

  it("finds a name that is present", async () => {
    assert.equal(
      await scanTextChunks(
        chunked(strings("Acme", "Jonathan Wheeler"), 4096),
        NAME,
      ),
      true,
    );
  });
  it("is case-insensitive", async () => {
    assert.equal(
      await scanTextChunks(chunked(strings("JONATHAN WHEELER"), 4096), NAME),
      true,
    );
  });
  it("rejects a data set that only has a common first name (the claimant files)", async () => {
    assert.equal(
      await scanTextChunks(
        chunked(strings("Jonathan Silva", "Maria Wheelan"), 4096),
        NAME,
      ),
      false,
    );
  });
  it("finds a name split across chunk boundaries, inside a word and inside a tag", async () => {
    const text = strings("filler ".repeat(200), "Jonathan Wheeler", "end");
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      assert.equal(
        await scanTextChunks(chunked(text, size), NAME),
        true,
        `chunk size ${size}`,
      );
    }
  });
  it("finds a name split across formatting runs inside one cell", async () => {
    const text =
      "<sst><si><r><t>Jonath</t></r><r><t>an Whee</t></r><r><t>ler</t></r></si></sst>";
    for (const size of [4096, 3]) {
      assert.equal(
        await scanTextChunks(chunked(text, size), NAME),
        true,
        `chunk size ${size}`,
      );
    }
  });
  it("decodes XML entities", async () => {
    assert.equal(
      await scanTextChunks(chunked(strings("Conor O&apos;Brien &amp; Co"), 5), [
        ["o'brien"],
      ]),
      true,
    );
  });
  it("counts a name spread over different cells as possibly relevant (never drops it)", async () => {
    assert.equal(
      await scanTextChunks(chunked(strings("Jonathan", "Wheeler"), 4096), NAME),
      true,
    );
  });
  it("matches any one of several criteria", async () => {
    assert.equal(
      await scanTextChunks(chunked(strings("jw@example.com"), 4096), [
        ["jonathan", "wheeler"],
        ["jw@example.com"],
      ]),
      true,
    );
  });
});

function makeXlsx(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-scan-"));
  const target = path.join(dir, "book [1].xlsx");
  const build = `
import sys, json, zipfile
files = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for name, content in files.items():
        z.writestr(name, content)
`;
  const result = spawnSync("python3", [
    "-c",
    build,
    target,
    JSON.stringify(files),
  ]);
  assert.equal(result.status, 0, result.stderr?.toString());
  return target;
}

describe("scanXlsxForMentions", () => {
  const sst = (...items: string[]) =>
    `<?xml version="1.0"?><sst>${items.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`;

  it("reports a workbook that mentions the subject", async () => {
    const file = makeXlsx({
      "xl/sharedStrings.xml": sst("Name", "Jonathan Wheeler"),
    });
    assert.equal(
      (await scanXlsxForMentions(file, ["jonathan wheeler"])).status,
      "mentioned",
    );
  });
  it("reports a workbook that does not", async () => {
    const file = makeXlsx({
      "xl/sharedStrings.xml": sst("Name", "Jonathan Silva", "CPF"),
    });
    assert.equal(
      (await scanXlsxForMentions(file, ["jonathan wheeler"])).status,
      "not-mentioned",
    );
  });
  it("says 'unsupported' when it cannot tell, so the normal path still runs", async () => {
    const noStrings = makeXlsx({ "xl/workbook.xml": "<workbook/>" });
    assert.equal(
      (await scanXlsxForMentions(noStrings, ["jonathan wheeler"])).status,
      "unsupported",
    );
    const notZip = path.join(os.tmpdir(), `old-${Date.now()}.xls`);
    fs.writeFileSync(notZip, "not a zip file at all");
    assert.equal(
      (await scanXlsxForMentions(notZip, ["jonathan wheeler"])).status,
      "unsupported",
    );
    assert.equal(
      (
        await scanXlsxForMentions("/definitely/not/here.xlsx", [
          "jonathan wheeler",
        ])
      ).status,
      "unsupported",
    );
    const fine = makeXlsx({ "xl/sharedStrings.xml": sst("x") });
    assert.equal((await scanXlsxForMentions(fine, [])).status, "unsupported");
  });
});

describe("shouldPrescreenSpreadsheet", () => {
  const mb = (n: number) => n * 1024 * 1024;
  it("applies to large xlsx/xlsm only", () => {
    assert.equal(shouldPrescreenSpreadsheet(".xlsx", mb(30), 20), true);
    assert.equal(shouldPrescreenSpreadsheet(".xlsm", mb(20), 20), true);
    assert.equal(shouldPrescreenSpreadsheet(".xlsx", mb(5), 20), false);
    assert.equal(shouldPrescreenSpreadsheet(".xls", mb(500), 20), false);
    assert.equal(shouldPrescreenSpreadsheet(".csv", mb(500), 20), false);
    assert.equal(shouldPrescreenSpreadsheet(".docx", mb(500), 20), false);
  });
});
