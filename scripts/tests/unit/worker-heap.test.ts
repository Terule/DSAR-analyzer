import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heapOption } from "../../../src/lib/worker-heap";

describe("heapOption", () => {
  it("changes nothing when no heap size is configured", () => {
    assert.equal(heapOption(2048, undefined), null);
    assert.equal(heapOption(2048, ""), null);
    assert.equal(heapOption(2048, "   "), null);
  });
  it("ignores values that are not a positive number", () => {
    assert.equal(heapOption(4096, "abc"), null);
    assert.equal(heapOption(4096, "0"), null);
    assert.equal(heapOption(4096, "-512"), null);
  });
  it("turns a valid size into the Node flag", () => {
    assert.equal(heapOption(6144, "4608"), "--max-old-space-size=4608");
  });
  it("never lets the heap crowd out the rest of the container's memory", () => {
    // 6144MB container: at most 85% = 5222MB, so a request for 6000 is clamped
    // and Node can't grow past what the container allows (which would be an
    // abrupt OOM kill instead of an error).
    assert.equal(heapOption(6144, "6000"), "--max-old-space-size=5222");
    assert.equal(heapOption(2048, "2048"), "--max-old-space-size=1740");
  });
  it("rounds to a whole number of megabytes", () => {
    assert.equal(heapOption(8192, "4096.9"), "--max-old-space-size=4096");
  });
});
