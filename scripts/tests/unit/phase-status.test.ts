import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  combinePhaseStatus,
  extractPhaseStatus,
  parsePhaseStatus,
  renderPhaseStatus,
  renderProgress,
} from "../../../src/lib/phase-status";

const rows = (...statuses: string[]) => statuses.map((status) => ({ status }));

describe("parsePhaseStatus", () => {
  it("is processing while any PST is being scanned or parsed", () => {
    assert.equal(
      parsePhaseStatus(rows("scanning_metadata", "scanning_metadata")),
      "processing",
    );
    assert.equal(
      parsePhaseStatus(rows("completed", "processing")),
      "processing",
    );
    assert.equal(
      parsePhaseStatus(rows("analyzed", "pending_analysis")),
      "processing",
    );
  });
  it("reports failure even while other PSTs are still running", () => {
    assert.equal(parsePhaseStatus(rows("failed", "processing")), "failed");
  });
  it("falls back to the first row's status otherwise", () => {
    assert.equal(parsePhaseStatus(rows("completed", "completed")), "completed");
    assert.equal(parsePhaseStatus(rows("analyzed")), "analyzed");
    assert.equal(parsePhaseStatus([]), "pending");
  });
});

describe("extractPhaseStatus", () => {
  it("is pending while PSTs are still being parsed", () => {
    assert.equal(
      extractPhaseStatus(rows("scanning_metadata", "processing")),
      "pending",
    );
  });
  it("is extracting while any PST extracts, completed once all are", () => {
    assert.equal(
      extractPhaseStatus(rows("extracting", "processing")),
      "extracting",
    );
    assert.equal(
      extractPhaseStatus(rows("completed", "completed")),
      "completed",
    );
  });
  it("reports failure", () => {
    assert.equal(extractPhaseStatus(rows("failed", "completed")), "failed");
  });
  it("is pending for an empty request", () => {
    assert.equal(extractPhaseStatus([]), "pending");
  });
});

const pdf = (...statuses: string[]) =>
  statuses.map((pdf_status) => ({ pdf_status }));

describe("renderPhaseStatus", () => {
  it("is completed only when every PST row has rendered", () => {
    assert.equal(renderPhaseStatus(pdf("completed", "completed")), "completed");
    assert.equal(renderPhaseStatus(pdf("completed", "pending")), "pending");
  });
  it("shows a failure that sits on any row, not just the first", () => {
    assert.equal(renderPhaseStatus(pdf("pending", "failed")), "failed");
    assert.equal(renderPhaseStatus(pdf("completed", "failed")), "failed");
  });
  it("is processing while any row is rendering", () => {
    assert.equal(renderPhaseStatus(pdf("pending", "processing")), "processing");
  });
  it("is pending for an empty request", () => {
    assert.equal(renderPhaseStatus([]), "pending");
  });
});

describe("renderProgress", () => {
  const row = (
    pdf_status: string,
    pdf_total: number,
    pdf_processed: number,
  ) => ({
    pdf_status,
    pdf_total,
    pdf_processed,
  });

  it("has no total until Render has counted its emails", () => {
    assert.deepEqual(
      renderProgress([row("pending", 0, 0), row("pending", 0, 0)]),
      { done: 0, total: 0 },
    );
  });

  it("counts only the emails Render knows about while it runs", () => {
    assert.deepEqual(
      renderProgress([
        row("processing", 500, 120),
        row("pending", 0, 0),
        row("pending", 0, 0),
      ]),
      { done: 120, total: 500 },
    );
  });

  it("counts a finished row as at least one so an empty Render still completes", () => {
    assert.deepEqual(
      renderProgress([row("completed", 59, 59), row("completed", 0, 0)]),
      { done: 60, total: 60 },
    );
  });
});

describe("combinePhaseStatus", () => {
  it("keeps an earlier wave's completion while a later wave has not started", () => {
    assert.equal(combinePhaseStatus(["completed", "pending"]), "pending");
    assert.equal(combinePhaseStatus(["completed"]), "completed");
  });

  it("is completed only when every wave is", () => {
    assert.equal(combinePhaseStatus(["completed", "completed"]), "completed");
  });

  it("shows the newest wave that is moving", () => {
    assert.equal(combinePhaseStatus(["completed", "processing"]), "processing");
    assert.equal(
      combinePhaseStatus(["processing", "completed", "extracting"]),
      "extracting",
    );
  });

  it("surfaces a failure from any wave", () => {
    assert.equal(combinePhaseStatus(["failed", "completed"]), "failed");
  });

  it("matches a single wave and an empty list", () => {
    assert.equal(combinePhaseStatus(["processing"]), "processing");
    assert.equal(combinePhaseStatus(["pending"]), "pending");
    assert.equal(combinePhaseStatus([]), "pending");
  });
});
