import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { officeHeapMb } from "../../../src/lib/office-heap";

describe("officeHeapMb", () => {
  it("keeps the spreadsheet thread's heap below the container limit", () => {
    // A regular Files worker has 1.5GB; a 2GB heap let the container be
    // killed (taking the whole 100-file batch with it) before V8 could fail the
    // one oversized file gracefully.
    assert.equal(officeHeapMb(1536), 1024);
    assert.ok(officeHeapMb(1536) < 1536);
  });
  it("scales with the container so a bigger lane gets a bigger heap", () => {
    assert.equal(officeHeapMb(3072), 2048);
    assert.equal(officeHeapMb(6144), 4096);
  });
  it("never goes below a usable minimum", () => {
    assert.equal(officeHeapMb(100), 256);
    assert.equal(officeHeapMb(0), 256);
  });
});
