import assert from "node:assert/strict";
import test from "node:test";
import {
  type Converse,
  runSecondReview,
  type SecondReviewAdapter,
} from "../../../src/lib/second-review";

const fakeConverse: Converse = async () => ({});

function adapter(rows: string[][], log: string[]): SecondReviewAdapter<string> {
  const batches = [...rows];
  return {
    name: "test",
    async reclaimStale() {
      log.push("reclaim");
    },
    async giveUpWithoutCredentials() {
      log.push("give-up");
      return 2;
    },
    async claim() {
      return batches.length === 0 ? null : (batches.shift() as string[]);
    },
    async settle(row) {
      log.push(`settle:${row}`);
    },
    async finish() {
      log.push("finish");
    },
  };
}

test("claims in rounds until nothing waits, then finishes", async () => {
  const log: string[] = [];
  const settled = await runSecondReview(adapter([["a", "b"], ["c"]], log), {
    converse: fakeConverse,
  });
  assert.equal(settled, 3);
  assert.equal(log[0], "reclaim");
  assert.equal(log.at(-1), "finish");
  assert.deepEqual(log.filter((entry) => entry.startsWith("settle")).sort(), [
    "settle:a",
    "settle:b",
    "settle:c",
  ]);
});

test("a round another worker won entirely does not stop the loop", async () => {
  const log: string[] = [];
  const settled = await runSecondReview(adapter([[], ["x"]], log), {
    converse: fakeConverse,
  });
  assert.equal(settled, 1);
});

test("stops at the time budget", async () => {
  const log: string[] = [];
  const settled = await runSecondReview(adapter([["a"], ["b"]], log), {
    converse: fakeConverse,
    timeBudgetMs: 0,
  });
  assert.equal(settled, 0);
  assert.equal(log.at(-1), "finish");
});
