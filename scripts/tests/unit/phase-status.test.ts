import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractPhaseStatus,
  parsePhaseStatus,
  renderPhaseStatus,
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
