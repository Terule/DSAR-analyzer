import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryTargets } from "../../../src/lib/retry-targets";

const row = (id: string, extra: Record<string, string> = {}) => ({
  id,
  kind: "pst",
  status: "completed",
  ai_status: "completed",
  pdf_status: "completed",
  files_status: "pending",
  ...extra,
});

describe("retryTargets", () => {
  it("is empty when nothing failed", () => {
    assert.deepEqual(retryTargets([row("a"), row("b")]), []);
    assert.deepEqual(retryTargets([]), []);
  });

  it("returns a failed Files row", () => {
    assert.deepEqual(
      retryTargets([
        row("a"),
        row("f", { kind: "files", files_status: "failed" }),
      ]),
      ["f"],
    );
  });

  it("returns every PST that failed Parse or Extract", () => {
    assert.deepEqual(
      retryTargets([
        row("a", { status: "failed" }),
        row("b"),
        row("c", { status: "failed" }),
      ]),
      ["a", "c"],
    );
  });

  it("returns one row for a case-level Render or AI failure, however many rows share it", () => {
    assert.deepEqual(
      retryTargets([
        row("a", { pdf_status: "failed" }),
        row("b", { pdf_status: "failed" }),
        row("c", { pdf_status: "failed" }),
      ]),
      ["a"],
    );
    assert.deepEqual(
      retryTargets([
        row("a", { ai_status: "failed" }),
        row("b", { ai_status: "failed" }),
      ]),
      ["a"],
    );
  });

  it("orders upstream steps first and never repeats a row", () => {
    assert.deepEqual(
      retryTargets([
        row("f", { kind: "files", files_status: "failed" }),
        row("r", { pdf_status: "failed" }),
        row("i", { ai_status: "failed" }),
        row("p", { status: "failed" }),
      ]),
      ["p", "i", "r", "f"],
    );
    assert.deepEqual(
      retryTargets([row("x", { status: "failed", pdf_status: "failed" })]),
      ["x"],
    );
  });

  it("ignores a Files row that is not failed, and rows of other kinds' Files status", () => {
    assert.deepEqual(
      retryTargets([
        row("f", { kind: "files", files_status: "processing" }),
        row("p", { files_status: "failed" }),
      ]),
      [],
    );
  });
});
