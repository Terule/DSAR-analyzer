import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyConfidentiality,
  confidentialCategory,
  EMAIL_CONFIDENTIALITY_PROMPT,
  SENSITIVITY_SCHEMA,
} from "../../../src/lib/email-audit";

const keep = {
  decision: "keep" as const,
  reason: "Subject is the sender",
  needsSecondPass: false,
};

describe("confidentialCategory", () => {
  it("returns the category when the model reports one", () => {
    assert.equal(
      confidentialCategory("payroll_compensation"),
      "payroll_compensation",
    );
  });
  it("treats none, missing and unknown values as not confidential", () => {
    for (const value of ["none", undefined, null, 3, "salary", ""]) {
      assert.equal(confidentialCategory(value), null, String(value));
    }
  });
});

describe("applyConfidentiality", () => {
  it("discards a confidential email even when the subject is the sender", () => {
    const out = applyConfidentiality({
      ...keep,
      sensitivity: "payroll_compensation",
    });
    assert.equal(out.decision, "discard");
    assert.equal(out.confidential, true);
    assert.match(out.reason, /payroll_compensation/);
  });

  it("never lets a second pass rescue a confidential email", () => {
    const out = applyConfidentiality({
      decision: "discard",
      reason: "weak",
      needsSecondPass: true,
      sensitivity: "legal_privileged",
    });
    assert.equal(out.needsSecondPass, false);
  });

  it("leaves a non-confidential decision untouched", () => {
    assert.deepEqual(applyConfidentiality({ ...keep, sensitivity: "none" }), {
      ...keep,
      confidential: false,
    });
  });

  it("behaves as before when an older batch has no sensitivity field", () => {
    const out = applyConfidentiality({ ...keep, sensitivity: undefined });
    assert.equal(out.decision, "keep");
    assert.equal(out.confidential, false);
  });

  it("caps the reason at 240 characters", () => {
    const out = applyConfidentiality({
      ...keep,
      reason: "r".repeat(500),
      sensitivity: "other_confidential",
    });
    assert.equal(out.reason.length, 240);
  });
});

describe("audit prompt wiring", () => {
  it("lists every category in the schema and the prompt", () => {
    assert.ok(SENSITIVITY_SCHEMA.enum.includes("payroll_compensation"));
    assert.match(EMAIL_CONFIDENTIALITY_PROMPT, /payroll_compensation/);
    assert.match(EMAIL_CONFIDENTIALITY_PROMPT, /always "discard"/);
  });
});
