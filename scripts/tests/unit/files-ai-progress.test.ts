import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filesAiReview } from "../../../src/lib/files-ai-progress";

describe("filesAiReview", () => {
  it("shows the AI review while files are being judged", () => {
    assert.deepEqual(
      filesAiReview({
        status: "processing",
        done: 100,
        total: 100,
        ai: { done: 30, total: 120 },
      }),
      { label: "AI review", detail: "30/120 reviewed" },
    );
  });

  it("shows nothing when every verdict is in", () => {
    assert.equal(
      filesAiReview({
        status: "processing",
        done: 100,
        total: 100,
        ai: { done: 120, total: 120 },
      }),
      null,
    );
  });

  it("shows nothing without AI data, when there is nothing to review, or when not processing", () => {
    assert.equal(filesAiReview(undefined), null);
    assert.equal(
      filesAiReview({ status: "processing", done: 1, total: 2 }),
      null,
    );
    assert.equal(
      filesAiReview({
        status: "processing",
        done: 1,
        total: 2,
        ai: { done: 0, total: 0 },
      }),
      null,
    );
    assert.equal(
      filesAiReview({
        status: "completed",
        done: 1,
        total: 1,
        ai: { done: 1, total: 5 },
      }),
      null,
    );
  });
});
