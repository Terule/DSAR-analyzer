import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createThrottle } from "../../../src/lib/sweep-throttle";

describe("createThrottle", () => {
  it("lets the first call through immediately", () => {
    const throttle = createThrottle(60_000, () => 1_000);
    assert.equal(throttle(), true);
  });
  it("blocks calls inside the interval and allows one once it has passed", () => {
    let now = 0;
    const throttle = createThrottle(60_000, () => now);
    assert.equal(throttle(), true);
    now = 1_000;
    assert.equal(throttle(), false);
    now = 59_999;
    assert.equal(throttle(), false);
    now = 60_000;
    assert.equal(throttle(), true);
    now = 60_001;
    assert.equal(throttle(), false);
  });
  it("measures the interval from the last allowed call, not the blocked ones", () => {
    let now = 0;
    const throttle = createThrottle(10_000, () => now);
    throttle();
    for (now = 1_000; now < 10_000; now += 1_000) throttle();
    now = 10_000;
    assert.equal(throttle(), true);
  });
});
