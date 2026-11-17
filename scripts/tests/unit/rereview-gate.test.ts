import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inControlSample,
  shouldRereview,
} from "../../../src/lib/bedrock/rereview-gate";

const config = { minPKeep: 8, sampleRate: 0 };
const base = {
  id: "v1",
  pKeep: 2,
  sensitivity: "payroll_compensation",
  subjectInvolved: false,
};

describe("shouldRereview", () => {
  it("leaves an obvious discard final", () => {
    assert.equal(shouldRereview(base, config), false);
  });

  it("reviews when the model shows doubt", () => {
    assert.equal(shouldRereview({ ...base, pKeep: 8 }, config), true);
    assert.equal(shouldRereview({ ...base, pKeep: 40 }, config), true);
    assert.equal(shouldRereview({ ...base, pKeep: 7 }, config), false);
  });

  it("reviews when there is no estimate at all", () => {
    assert.equal(shouldRereview({ ...base, pKeep: null }, config), true);
    assert.equal(shouldRereview({ ...base, pKeep: undefined }, config), true);
  });

  it("reviews the categories Haiku 4.5 over-applies", () => {
    for (const sensitivity of [
      "legal_privileged",
      "hr_investigation_or_discipline",
    ]) {
      assert.equal(shouldRereview({ ...base, sensitivity }, config), true);
    }
    assert.equal(
      shouldRereview(
        { ...base, sensitivity: "third_party_personal_data" },
        config,
      ),
      false,
    );
  });

  it("reviews when the subject is plainly involved", () => {
    assert.equal(
      shouldRereview({ ...base, subjectInvolved: true }, config),
      true,
    );
  });

  it("adds a deterministic control sample of the confident discards", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `verdict-${i}`);
    const picked = ids.filter((id) => inControlSample(id, 0.02));
    assert.ok(
      picked.length > 50 && picked.length < 150,
      `got ${picked.length}`,
    );
    assert.deepEqual(
      picked,
      ids.filter((id) => inControlSample(id, 0.02)),
      "the same ids every time",
    );
    assert.equal(ids.filter((id) => inControlSample(id, 0)).length, 0);
    assert.equal(shouldRereview(base, { minPKeep: 8, sampleRate: 1 }), true);
  });
});
