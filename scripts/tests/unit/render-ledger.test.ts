import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { openRenderLedger } from "../../../src/lib/render-ledger";

function tempFile() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")),
    "render-ledger.jsonl",
  );
}

describe("openRenderLedger", () => {
  it("numbers emails 1, 2, 3 in the order they are first seen", () => {
    const ledger = openRenderLedger(tempFile(), 0);
    assert.equal(ledger.numberFor("aaa"), 1);
    assert.equal(ledger.numberFor("bbb"), 2);
    assert.equal(ledger.numberFor("ccc"), 3);
  });
  it("continues after the wave's base number", () => {
    const ledger = openRenderLedger(tempFile(), 3451);
    assert.equal(ledger.numberFor("aaa"), 3452);
  });
  it("gives an email the same number every time it is asked", () => {
    const ledger = openRenderLedger(tempFile(), 0);
    assert.equal(ledger.numberFor("aaa"), 1);
    assert.equal(ledger.numberFor("aaa"), 1);
    assert.equal(ledger.numberFor("bbb"), 2);
  });
  it("survives a retry: known emails keep their numbers, new ones follow", () => {
    const file = tempFile();
    const first = openRenderLedger(file, 0);
    first.numberFor("aaa");
    first.numberFor("bbb");
    first.numberFor("ccc");
    // The worker died; the retry only sees the emails that were left over.
    const retry = openRenderLedger(file, 0);
    assert.equal(retry.numberFor("ccc"), 3);
    assert.equal(retry.numberFor("ddd"), 4);
    assert.equal(retry.max, 4);
  });
  it("never reuses a number even when the base is behind the ledger", () => {
    const file = tempFile();
    const first = openRenderLedger(file, 0);
    for (const h of ["a", "b", "c"]) first.numberFor(h);
    assert.equal(openRenderLedger(file, 1).numberFor("new"), 4);
  });
  it("remembers emails skipped on purpose and counts them once", () => {
    const file = tempFile();
    const first = openRenderLedger(file, 0);
    first.numberFor("aaa");
    first.markSkipped("aaa");
    first.markSkipped("aaa");
    assert.equal(first.skippedCount, 1);
    assert.equal(openRenderLedger(file, 0).skippedCount, 1);
  });
  it("tells a retry which emails were skipped on purpose", () => {
    const file = tempFile();
    const first = openRenderLedger(file, 0);
    first.numberFor("aaa");
    first.numberFor("bbb");
    first.markSkipped("bbb");
    assert.equal(first.isSkipped("aaa"), false);
    assert.equal(first.isSkipped("bbb"), true);
    const retry = openRenderLedger(file, 0);
    assert.equal(retry.isSkipped("bbb"), true);
    assert.equal(retry.isSkipped("zzz"), false);
  });
  it("ignores a half-written last line left by a crash", () => {
    const file = tempFile();
    const first = openRenderLedger(file, 0);
    first.numberFor("aaa");
    first.numberFor("bbb");
    fs.appendFileSync(file, '{"h":"ccc","n":');
    const retry = openRenderLedger(file, 0);
    assert.equal(retry.numberFor("bbb"), 2);
    assert.equal(retry.numberFor("ccc"), 3);
  });
  it("starts empty when the file does not exist yet", () => {
    const ledger = openRenderLedger(
      path.join(os.tmpdir(), `nope-${Date.now()}`, "x.jsonl"),
      0,
    );
    assert.equal(ledger.max, 0);
    assert.equal(ledger.skippedCount, 0);
  });
});
