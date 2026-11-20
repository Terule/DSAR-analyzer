import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisLabel,
  buildActivity,
  buildFunnel,
  rulesForStep,
} from "../../../src/lib/request-insights";

const group = (state: string, rule: string | null, count: number) => ({
  state,
  rule,
  count,
});

test("the funnel subtracts each fixed filter in order and splits the AI verdict", () => {
  const funnel = buildFunnel([
    group("discarded", "dup", 20),
    group("discarded", "unsupported_type", 5),
    group("discarded", "keyword", 10),
    group("discarded", "subject_absent", 40),
    group("kept", "ai_email", 12),
    group("discarded", "ai_email", 8),
    group("pending", null, 5),
  ]);
  assert.equal(funnel.total, 100);
  assert.deepEqual(
    funnel.rows.map((row) => [row.key, row.value, row.removed]),
    [
      ["received", 100, 0],
      ["duplicates", 80, 20],
      ["type", 75, 5],
      ["keyword", 65, 10],
      ["subject", 25, 40],
      ["ai", 25, 0],
    ],
  );
  assert.equal(funnel.removedPercent, 75);
  assert.deepEqual(
    {
      kept: funnel.ai.kept,
      discarded: funnel.ai.discarded,
      waiting: funnel.ai.waiting,
    },
    { kept: 12, discarded: 8, waiting: 5 },
  );
  assert.equal(funnel.ai.keptPercent, 48);
});

test("the other fixed filters row appears only when something was removed by them", () => {
  assert.ok(
    !buildFunnel([group("kept", "ai_email", 3)]).rows.some(
      (row) => row.key === "other",
    ),
  );
  assert.ok(
    buildFunnel([group("discarded", "draft", 2)]).rows.some(
      (row) => row.key === "other",
    ),
  );
});

test("an empty request has an empty funnel", () => {
  const funnel = buildFunnel([]);
  assert.equal(funnel.total, 0);
  assert.equal(funnel.removedPercent, 0);
  assert.equal(funnel.ai.keptPercent, 0);
});

test("steps map to the rules behind them", () => {
  assert.deepEqual(rulesForStep("duplicates"), ["dup"]);
  assert.ok(rulesForStep("ai")?.includes("ai_email"));
  assert.equal(rulesForStep("nope"), null);
});

test("the analysis label tells the generations apart", () => {
  assert.equal(
    analysisLabel("haiku-5.5", "ai_email", "kept", false),
    "2nd analysis",
  );
  assert.equal(
    analysisLabel("bedrock-batch", "ai_email", "discarded", false),
    "1st analysis",
  );
  assert.equal(analysisLabel("rule", "dup", "discarded", false), "Rule");
  assert.equal(
    analysisLabel("bedrock-batch", "ai_email", "pending", true),
    "2nd analysis",
  );
});

test("activity times follow the phase durations", () => {
  const events = buildActivity({
    startedAt: 1_000,
    readMs: 100,
    prepareMs: 200,
    aiMs: 300,
    renderMs: 0,
    filesMs: 0,
    done: { read: true, prepare: true, ai: false, render: false, files: false },
    aiStarted: true,
    reanalysing: true,
    completedAt: null,
    hasFiles: false,
  });
  assert.deepEqual(
    events.map((event) => [event.label, event.at]),
    [
      ["Case started", 1_000],
      ["Read completed", 1_100],
      ["Prepare completed", 1_300],
      ["AI review started (1st analysis)", 1_300],
      ["Reanalysis of doubtful discards", null],
    ],
  );
});
