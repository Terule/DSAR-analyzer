import assert from "node:assert/strict";
import test from "node:test";
import { emailDecision } from "../../../src/lib/items";

const none = { rereview_status: null };

test("an undecided email is pending", () => {
  assert.deepEqual(
    emailDecision({ ai_decision: null, ai_reason: null, ...none }),
    { state: "pending", rule: null, reason: null },
  );
});

test("pre-filter reasons map to their rule", () => {
  const cases: [string, string][] = [
    [
      "Pre-filter: Subject or body contains privileged/confidential keyword",
      "keyword",
    ],
    ["Pre-filter: Data subject not mentioned", "subject_absent"],
    ["System Discard: Draft (Missing Routing Headers)", "draft"],
  ];
  for (const [reason, rule] of cases) {
    const decision = emailDecision({
      ai_decision: "discard",
      ai_reason: reason,
      ...none,
    });
    assert.equal(decision.state, "discarded");
    assert.equal(decision.rule, rule);
  }
});

test("client case keep, self-forward warning and AI decisions", () => {
  assert.deepEqual(
    emailDecision({
      ai_decision: "keep",
      ai_reason: "Client case: deduplication only",
      ...none,
    }),
    {
      state: "kept",
      rule: "client_case",
      reason: "Client case: deduplication only",
    },
  );
  assert.equal(
    emailDecision({
      ai_decision: "warning",
      ai_reason: "Self-forward: Subject sent from company email personal email",
      ...none,
    }).state,
    "review",
  );
  const ai = emailDecision({
    ai_decision: "discard",
    ai_reason: "Not about the subject",
    ...none,
  });
  assert.equal(ai.rule, "ai_email");
  assert.equal(ai.state, "discarded");
});
