import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSample,
  SAMPLE_LIMITS,
  subjectClearlyInvolved,
  subjectMentionTokens,
} from "../../../src/lib/files-ai-text";

const LARGE = SAMPLE_LIMITS.maxChars * 10;

describe("buildSample", () => {
  it("sends short text whole and not sampled", () => {
    const out = buildSample("Hello Jonathan Wheeler", ["jonathan wheeler"]);
    assert.equal(out.sampled, false);
    assert.equal(out.text, "Hello Jonathan Wheeler");
  });

  it("samples text that does not fit instead of cutting it off", () => {
    const text = `${"a".repeat(SAMPLE_LIMITS.maxChars + 500)}\nJonathan Wheeler wrote this`;
    const out = buildSample(text, ["jonathan wheeler"]);
    assert.equal(out.sampled, true);
    assert.ok(out.text.includes("Jonathan Wheeler wrote this"));
  });

  it("samples large text: head plus the lines that mention the subject", () => {
    const filler = "lorem ipsum dolor sit amet\n".repeat(
      Math.ceil(LARGE / 27) + 10,
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
    const text = `${"z".repeat(LARGE)}\n${lines}`;
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

describe("subjectClearlyInvolved", () => {
  const criteria = {
    name: "Gemma Anderson",
    email: "ganderson@corp.com",
    aliases: ["Gemma Helen Anderson"],
  };

  it("keeps a file that contains the subject's email", () => {
    assert.equal(
      subjectClearlyInvolved("cc: GAnderson@corp.com\nhello", criteria),
      true,
    );
  });

  it("keeps a chat the subject wrote or a transcript they speak in", () => {
    assert.equal(
      subjectClearlyInvolved("Gemma Anderson 6/17/2026 5:56 PM\nhi", criteria),
      true,
    );
    assert.equal(
      subjectClearlyInvolved(
        "Message edited: Gemma Anderson <x> 4/15/2026",
        criteria,
      ),
      true,
    );
    assert.equal(
      subjectClearlyInvolved(
        "Bob 25:40\nok\nGemma Anderson 25:47\nYeah",
        criteria,
      ),
      true,
    );
  });

  it("leaves a name that only appears in the body to the AI", () => {
    assert.equal(
      subjectClearlyInvolved("please ask Gemma Anderson about it", criteria),
      false,
    );
    assert.equal(subjectClearlyInvolved("", criteria), false);
  });
});

describe("subjectClearlyInvolved in a Teams excerpt", () => {
  it("is never decided by who wrote the messages", () => {
    const criteria = {
      name: "Maria Souza",
      email: "maria.souza@corp.com",
      aliases: [],
    };
    const text =
      "Excerpts of a Teams conversation of 12 messages.\nMaria Souza 10:02\nplease redraft the letter";
    assert.equal(subjectClearlyInvolved(text, criteria), false);
    assert.equal(
      subjectClearlyInvolved(
        "Maria Souza 10:02\nplease redraft the letter",
        criteria,
      ),
      true,
    );
  });
});
