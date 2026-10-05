import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { computeEmailHash, dedupScope } from "../../../src/lib/email-dedup";

describe("dedupScope", () => {
  it("reduces a PST path to its request's PST scope", () => {
    assert.equal(dedupScope("MOW/R1/PST/wave1.pst"), "MOW/R1/PST");
    assert.equal(dedupScope("MOW/R1/PST/export/sub/x.pst"), "MOW/R1/PST");
  });
  it("accepts backslash separators and ignores empty segments", () => {
    assert.equal(dedupScope("MOW\\R1\\PST\\wave1.pst"), "MOW/R1/PST");
    assert.equal(dedupScope("/MOW//R1/PST/wave1.pst"), "MOW/R1/PST");
  });
  it("falls back to the legacy dirname for short paths", () => {
    assert.equal(dedupScope("x.pst"), ".");
    assert.equal(dedupScope("R1/x.pst"), "R1");
  });
});

describe("computeEmailHash", () => {
  const base = crypto.createHash("sha256").update("abc@example").digest("hex");
  it("is sha256 of '<scope>::<base>'", () => {
    const expected = crypto
      .createHash("sha256")
      .update(`MOW/R1/PST::${base}`)
      .digest("hex");
    assert.equal(computeEmailHash("MOW/R1/PST", base), expected);
    assert.equal(computeEmailHash("MOW/R1/PST", base), expected);
  });
  it("dedups across PST filenames of one request, not across requests", () => {
    const a = computeEmailHash(dedupScope("MOW/R1/PST/wave1.pst"), base);
    const b = computeEmailHash(dedupScope("MOW/R1/PST/wave2.pst"), base);
    const c = computeEmailHash(dedupScope("MOW/R2/PST/wave1.pst"), base);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
