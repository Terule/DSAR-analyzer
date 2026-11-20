import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCost, usageOf } from "../../../src/lib/ai-cost";

describe("AI cost estimate", () => {
  it("is zero with nothing sent", () => {
    assert.equal(estimateCost(0, 0), 0);
  });

  it("prices input and a short output at Batch rates", () => {
    // 1M input tokens at 0.50, plus 10,000 records x 120 output tokens at 2.50.
    const cost = estimateCost(1_000_000, 10_000);
    assert.ok(Math.abs(cost - (0.5 + 3)) < 1e-9);
  });

  it("keeps the inputs next to the cost", () => {
    const usage = usageOf(2_000, 4);
    assert.equal(usage.inputTokens, 2_000);
    assert.equal(usage.records, 4);
    assert.ok(usage.costUsd > 0);
  });
});
