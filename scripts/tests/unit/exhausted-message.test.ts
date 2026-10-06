import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exhaustedMessage } from "../../../src/lib/control-plane/exhausted";

describe("exhaustedMessage", () => {
  it("describes a job that used up all its attempts, with the last error", () => {
    assert.equal(
      exhaustedMessage("render", {
        status: "dead_letter",
        lastError: "Worker exited 133: unknown error",
      }),
      "Render failed after repeated attempts: Worker exited 133: unknown error",
    );
  });
  it("copes with a missing error", () => {
    assert.equal(
      exhaustedMessage("parse", { status: "dead_letter", lastError: null }),
      "Parse failed after repeated attempts.",
    );
  });
  it("trims a very long error", () => {
    const message = exhaustedMessage("ai", {
      status: "dead_letter",
      lastError: "x".repeat(2000),
    });
    assert.ok(message && message.length < 400);
  });
  it("is null for any job that can still make progress", () => {
    for (const status of ["queued", "leased", "running", "completed"]) {
      assert.equal(
        exhaustedMessage("render", { status, lastError: null }),
        null,
      );
    }
    assert.equal(exhaustedMessage("render", null), null);
  });
});
