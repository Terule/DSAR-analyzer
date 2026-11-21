import assert from "node:assert/strict";
import test from "node:test";
import { buildOutcomes } from "../../../src/lib/request-insights";

const g = (
  kind: "emails" | "files",
  state: string,
  rule: string | null,
  count: number,
) => ({ kind, state, rule, count });

test("duplicates are counted apart and every segment adds up to the unique items", () => {
  const [bar] = buildOutcomes([
    g("emails", "discarded", "dup", 600),
    g("emails", "discarded", "subject_absent", 200),
    g("emails", "discarded", "keyword", 20),
    g("emails", "discarded", "ai_email", 120),
    g("emails", "kept", "ai_email", 50),
    g("emails", "review", "ai_email", 2),
    g("emails", "pending", null, 8),
  ]);
  assert.equal(bar.kind, "emails");
  assert.equal(bar.received, 1000);
  assert.equal(bar.duplicates, 600);
  assert.equal(bar.unique, 400);
  assert.equal(
    bar.segments.reduce((sum, segment) => sum + segment.count, 0),
    bar.unique,
  );
  assert.deepEqual(
    bar.segments.map((segment) => segment.key),
    ["keyword", "subject", "ai_discarded", "review", "kept", "waiting"],
  );
});

test("emails and files each get their own bar, empty kinds none", () => {
  const bars = buildOutcomes([
    g("files", "discarded", "dup", 5),
    g("files", "kept", "ai_file", 3),
    g("files", "discarded", "signature_image", 2),
  ]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].kind, "files");
  assert.equal(bars[0].unique, 5);
  assert.deepEqual(
    bars[0].segments.map((segment) => segment.key),
    ["other", "kept"],
  );
});

test("a kept item counts as kept whatever decided it, and an unknown rule counts as other", () => {
  const [bar] = buildOutcomes([
    g("files", "kept", "chat_excerpt", 4),
    g("files", "discarded", "some_new_rule", 1),
  ]);
  assert.equal(bar.segments.find((s) => s.key === "kept")?.count, 4);
  assert.equal(bar.segments.find((s) => s.key === "other")?.count, 1);
});

test("a step with a list behind it points to it, the waiting items have none", () => {
  const [bar] = buildOutcomes([
    g("emails", "discarded", "subject_absent", 3),
    g("emails", "pending", null, 1),
  ]);
  assert.equal(bar.segments.find((s) => s.key === "subject")?.step, "subject");
  assert.equal(bar.segments.find((s) => s.key === "waiting")?.step, null);
});
