import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runStandaloneBatch } from "../../../src/lib/standalone-processor";

const STREAMED = /not mentioned anywhere in this large workbook/;

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

async function run(file: string, input: string) {
  const messages: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "prescreen-out-"));
    const result = await runStandaloneBatch({
      inputDir: input,
      filePaths: [file],
      messagesDir: path.join(out, "Messages"),
      documentsDir: path.join(out, "Documents"),
      subjectCriteria: { name: "Jonathan Wheeler" },
    });
    return { result, log: messages.join("\n"), out };
  } finally {
    console.log = original;
  }
}

describe("Files engine: large-workbook pre-screen", () => {
  let previous: string | undefined;
  before(() => {
    previous = process.env.XLSX_PRESCREEN_MB;
    // Treat every test workbook as "large".
    process.env.XLSX_PRESCREEN_MB = "0.000001";
  });
  after(() => {
    if (previous === undefined) delete process.env.XLSX_PRESCREEN_MB;
    else process.env.XLSX_PRESCREEN_MB = previous;
  });

  it("drops a large workbook that never mentions the subject, without converting it", async () => {
    const input = fs.mkdtempSync(path.join(os.tmpdir(), "prescreen-in-"));
    const file = workbook(input, "Claimant Data.xlsx", [
      "Name",
      "Jonathan Silva",
      "CPF",
    ]);
    const { result, log, out } = await run(file, input);
    assert.equal(result.success, true);
    assert.equal(result.processedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.match(log, STREAMED);
    assert.deepEqual(fs.readdirSync(path.join(out, "Documents")), []);
  });

  it("lets a workbook that mentions the subject through to the normal conversion", async () => {
    const input = fs.mkdtempSync(path.join(os.tmpdir(), "prescreen-in-"));
    const file = workbook(input, "Contacts.xlsx", ["Name", "Jonathan Wheeler"]);
    const { log } = await run(file, input);
    assert.doesNotMatch(log, STREAMED);
  });

  it("does not screen workbooks below the size threshold", async () => {
    process.env.XLSX_PRESCREEN_MB = "500";
    try {
      const input = fs.mkdtempSync(path.join(os.tmpdir(), "prescreen-in-"));
      const file = workbook(input, "Small.xlsx", ["Name", "Jonathan Silva"]);
      const { log } = await run(file, input);
      assert.doesNotMatch(log, STREAMED);
    } finally {
      process.env.XLSX_PRESCREEN_MB = "0.000001";
    }
  });
});
