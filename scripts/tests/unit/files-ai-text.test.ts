import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSample,
  LARGE_TEXT_CHARS,
  SAMPLE_LIMITS,
  subjectMentionTokens,
} from "../../../src/lib/files-ai-text";

describe("buildSample", () => {
  it("sends short text whole and not sampled", () => {
    const out = buildSample("Hello Jonathan Wheeler", ["jonathan wheeler"]);
    assert.equal(out.sampled, false);
    assert.equal(out.text, "Hello Jonathan Wheeler");
  });

  it("truncates medium text at maxChars without marking it sampled", () => {
    const text = "a".repeat(SAMPLE_LIMITS.maxChars + 500);
    const out = buildSample(text, ["x"]);
    assert.equal(out.sampled, false);
    assert.equal(out.text.length, SAMPLE_LIMITS.maxChars);
  });

  it("samples large text: head plus the lines that mention the subject", () => {
    const filler = "lorem ipsum dolor sit amet\n".repeat(
      Math.ceil(LARGE_TEXT_CHARS / 27) + 10,
    );
    const text = `${filler}row 999 | Jonathan Wheeler | approved\n${filler}`;
    const out = buildSample(text, ["jonathan wheeler"]);
    assert.equal(out.sampled, true);
    assert.ok(out.text.includes("Jonathan Wheeler"));
    assert.ok(out.text.length <= SAMPLE_LIMITS.maxChars + 200);
  });

  it("caps mention lines and long lines", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `line ${i} jonathan wheeler ${"y".repeat(1000)}`,
    ).join("\n");
    const text = `${"z".repeat(LARGE_TEXT_CHARS)}\n${lines}`;
    const out = buildSample(text, ["jonathan wheeler"]);
    const mentionLines = out.text
      .split("\n")
      .filter((l) => l.includes("jonathan wheeler"));
    assert.ok(mentionLines.length <= SAMPLE_LIMITS.maxMentionLines);
    assert.ok(
      mentionLines.every((l) => l.length <= SAMPLE_LIMITS.maxLineChars),
    );
  });

  it("handles empty text", () => {
    assert.deepEqual(buildSample("", ["x"]), { text: "", sampled: false });
  });
});

describe("subjectMentionTokens", () => {
  it("lowercases and de-duplicates name, aliases and emails", () => {
    const tokens = subjectMentionTokens({
      name: "Jonathan Wheeler",
      email: "jw@corp.com",
      personalEmail: "JW@home.com",
      aliases: ["Jon W", "jon w", ""],
    });
    assert.deepEqual(tokens.sort(), [
      "jon w",
      "jonathan wheeler",
      "jw@corp.com",
      "jw@home.com",
    ]);
  });
});
