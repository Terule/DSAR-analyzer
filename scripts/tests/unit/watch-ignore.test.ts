import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withDataDirsIgnored } from "../../../next-watch-ignore.mjs";

// Mirrors what Next.js hands to the webpack hook: frozen options whose
// `ignored` is a RegExp that skips .git, .next and node_modules.
const NEXT_DEFAULT = Object.freeze({
  aggregateTimeout: 5,
  ignored:
    /^((?:[^/]*(?:\/|$))*)(\.(git|next)|node_modules)(\/((?:[^/]*(?:\/|$))*)(?:$|\/))?/,
});
const ROOT = "/workspace";

interface Options {
  ignored: RegExp;
  aggregateTimeout?: number;
}

function ignoredBy(watchOptions: Options, file: string): boolean {
  return watchOptions.ignored.test(file);
}

describe("withDataDirsIgnored", () => {
  const result: Options = withDataDirsIgnored(NEXT_DEFAULT, ROOT, [
    "logs",
    "batches",
  ]);

  it("stops watching the worker data folders and everything inside them", () => {
    assert.equal(ignoredBy(result, "/workspace/logs"), true);
    assert.equal(ignoredBy(result, "/workspace/logs/jobs/abc.log"), true);
    assert.equal(ignoredBy(result, "/workspace/batches"), true);
    assert.equal(ignoredBy(result, "/workspace/batches/batch_1.jsonl"), true);
  });
  it("keeps watching source files, including look-alike names", () => {
    assert.equal(ignoredBy(result, "/workspace/src/app/page.tsx"), false);
    assert.equal(ignoredBy(result, "/workspace/src/lib/logs.ts"), false);
    assert.equal(
      ignoredBy(result, "/workspace/batches-notes/readme.md"),
      false,
    );
    assert.equal(ignoredBy(result, "/workspace/src/logs/page.tsx"), false);
  });
  it("still ignores what Next.js already ignored", () => {
    assert.equal(
      ignoredBy(result, "/workspace/node_modules/react/index.js"),
      true,
    );
    assert.equal(ignoredBy(result, "/workspace/.next/cache/x"), true);
    assert.equal(ignoredBy(result, "/workspace/.git/HEAD"), true);
  });
  it("keeps the other options and does not mutate the frozen input", () => {
    assert.equal(result.aggregateTimeout, 5);
    assert.notEqual(result, NEXT_DEFAULT);
    assert.ok(NEXT_DEFAULT.ignored instanceof RegExp);
  });
  it("copes with missing options", () => {
    const fromNothing = withDataDirsIgnored(undefined, ROOT, ["logs"]);
    assert.equal(ignoredBy(fromNothing, "/workspace/logs/a.log"), true);
    assert.equal(ignoredBy(fromNothing, "/workspace/src/a.ts"), false);
  });
});
