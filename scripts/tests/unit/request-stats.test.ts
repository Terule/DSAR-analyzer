import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRequestStats,
  mergeRequestStats,
  type StatsRow,
} from "../../../src/lib/request-stats";

const row = (overrides: Partial<StatsRow>): StatsRow => ({
  id: "r",
  wave: 1,
  kind: "pst",
  total_emails: 0,
  unique_emails: 0,
  duplicate_emails: 0,
  ai_approved_count: 0,
  ai_discarded_count: 0,
  files_total: 0,
  files_processed: 0,
  files_skipped: 0,
  files_duplicates: 0,
  metadata_duration_ms: 0,
  analyze_duration_ms: 0,
  extract_duration_ms: 0,
  ai_duration_ms: 0,
  pdf_duration_ms: 0,
  files_duration_ms: 0,
  files_paused_ms: 0,
  ...overrides,
});

describe("buildRequestStats", () => {
  it("adds mail and files across waves instead of keeping the latest", () => {
    const stats = buildRequestStats(
      [
        row({
          id: "a",
          total_emails: 100,
          duplicate_emails: 60,
          unique_emails: 40,
          ai_discarded_count: 30,
          ai_approved_count: 10,
          ai_duration_ms: 1000,
        }),
        row({
          id: "b",
          wave: 2,
          kind: "files",
          files_total: 50,
          files_processed: 5,
          files_skipped: 45,
          files_duplicates: 8,
          files_duration_ms: 5000,
          files_paused_ms: 1000,
        }),
        row({
          id: "c",
          wave: 3,
          kind: "files",
          files_total: 20,
          files_processed: 4,
          files_skipped: 16,
        }),
      ],
      new Map([["b", 2]]),
    );
    assert.deepEqual(stats.mail, {
      sources: 1,
      scanned: 100,
      duplicates: 60,
      unique: 40,
      excluded: 30,
      selected: 10,
    });
    assert.deepEqual(stats.files, {
      found: 70,
      delivered: 9,
      skipped: 61,
      duplicates: 8,
      aiDiscarded: 2,
    });
    assert.deepEqual(
      stats.waves.map((wave) => [wave.wave, wave.workMs]),
      [
        [1, 1000],
        [2, 4000],
        [3, 0],
      ],
    );
  });

  it("is empty without rows", () => {
    const stats = buildRequestStats([]);
    assert.equal(stats.mail.scanned, 0);
    assert.equal(stats.files.found, 0);
    assert.deepEqual(stats.waves, []);
  });

  it("counts a Files row's total while it is still running", () => {
    const stats = buildRequestStats([
      row({
        kind: "files",
        files_total: 100,
        files_processed: 3,
        files_skipped: 7,
      }),
    ]);
    assert.equal(stats.files.found, 100);
  });
});

describe("mergeRequestStats", () => {
  it("sums requests and labels each wave with its request", () => {
    const a = buildRequestStats([row({ total_emails: 5 })]);
    const b = buildRequestStats([row({ wave: 2, total_emails: 7 })]);
    const merged = mergeRequestStats([
      { name: "R1", stats: a },
      { name: "R2", stats: b },
      { name: "R3", stats: undefined },
    ]);
    assert.equal(merged.mail.scanned, 12);
    assert.deepEqual(
      merged.waves.map((wave) => [wave.request, wave.wave]),
      [
        ["R1", 1],
        ["R2", 2],
      ],
    );
  });
});
